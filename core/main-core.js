// Electron 主进程（Windows 桌面版）：窗口、菜单、自动更新、输入框写入/发送，以及把翻译服务接到 IPC 上
'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createService, compareVersions } = require('./service');
const { createAccountManager } = require('./accounts');
const proxyLib = require('./proxy');
const { T } = require('./i18n');

// User-Agent 跟随 Electron 内置的 Chrome 版本，WhatsApp 不会提示“浏览器太旧”
function chromeUA() {
  const major = String(process.versions.chrome || '140').split('.')[0];
  const os =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 本机文件存储 ----------------
function userFile(name) {
  return path.join(app.getPath('userData'), name);
}
function readJSONFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}
// 先写临时文件再改名，写一半崩溃也不会损坏
function writeJSONFile(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const fileStorage = {
  async loadJSON(name, fallback) {
    return readJSONFile(userFile(name + '.json'), fallback);
  },
  async saveJSON(name, value) {
    writeJSONFile(userFile(name + '.json'), value);
  },
};
// API Key 用系统加密保存（Windows：DPAPI；Mac：钥匙串）
Object.defineProperty(fileStorage, 'encrypt', {
  get() {
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) return (t) => safeStorage.encryptString(String(t)).toString('base64');
    } catch (_) {}
    return undefined;
  },
});
Object.defineProperty(fileStorage, 'decrypt', {
  get() {
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) return (t) => safeStorage.decryptString(Buffer.from(String(t), 'base64'));
    } catch (_) {}
    return undefined;
  },
});

const fileKV = {
  async readLog() {
    let lines = [];
    try {
      lines = fs.readFileSync(userFile('wingman-chatlog.jsonl'), 'utf8').split('\n');
    } catch (_) {}
    const out = [];
    for (const l of lines) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch (_) {}
    }
    return out;
  },
  async appendLog(entry) {
    fs.appendFileSync(userFile('wingman-chatlog.jsonl'), JSON.stringify(entry) + '\n');
  },
  async get(name, fallback) {
    return readJSONFile(userFile(name + '.json'), fallback);
  },
  async set(name, value) {
    writeJSONFile(userFile(name + '.json'), value);
  },
};

// ---------------- 应用 ----------------
function createTranslatorApp(cfg) {
  // cfg: { appName, shortName, url, allowedHosts, repo, preload, extraDefaults, extraPageKeys, createExtras(service, kv) → handlers }
  let mainWin = null;
  let settingsWin = null;
  let lastUiLang = 'zh';
  let accounts = null; // 多账号管理器（每个账号独立登录数据 + 独立代理）

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  const service = createService({
    storage: fileStorage,
    extraDefaults: cfg.extraDefaults,
    extraPageKeys: cfg.extraPageKeys,
    onSettingsChanged: (view) => {
      if (accounts) accounts.allWebContents().forEach((wc) => wc.send('tr:settings-changed', view));
      if (view.uiLang !== lastUiLang) {
        lastUiLang = view.uiLang;
        buildMenu();
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('acc:ui-lang', view.uiLang);
        if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(T('设置 - ') + cfg.appName);
      }
    },
  });
  const extraHandlers = cfg.createExtras ? cfg.createExtras(service, fileKV) : {};

  // 聊天网页（任意一个账号）
  const isMainSender = (e) => !!accounts && accounts.isPageSender(e);
  // 左侧账号栏
  const isShellSender = (e) => mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents;
  const isSettingsSender = (e) => settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;

  function handle(channel, check, fn) {
    ipcMain.handle(channel, (e, arg) => {
      if (!check(e)) throw new Error('FORBIDDEN');
      return fn(arg, e);
    });
  }

  // ---- 窗口 ----
  function openExternalSafe(url) {
    if (/^(https?:|mailto:|tel:)/i.test(url)) shell.openExternal(url);
  }

  // 账号数据：代理密码用系统加密保存
  const accountStorage = {
    load() {
      const data = readJSONFile(userFile('accounts.json'), {}) || {};
      const dec = fileStorage.decrypt;
      (data.accounts || []).forEach((a) => {
        if (a.proxy && a.proxy.passwordEnc && dec) {
          try {
            a.proxy.password = dec(a.proxy.passwordEnc);
          } catch (_) {
            a.proxy.password = '';
          }
        }
        if (a.proxy) delete a.proxy.passwordEnc;
      });
      return data;
    },
    save(data) {
      const enc = fileStorage.encrypt;
      const out = {
        activeId: data.activeId,
        groups: data.groups || [],
        accounts: data.accounts.map((a) => {
          const c = { ...a, proxy: { ...(a.proxy || { type: 'none' }) } };
          if (c.proxy.password && enc) {
            c.proxy.passwordEnc = enc(c.proxy.password);
            delete c.proxy.password;
          }
          return c;
        }),
      };
      writeJSONFile(userFile('accounts.json'), out);
    },
  };

  function createMainWindow() {
    const ua = chromeUA();
    mainWin = new BrowserWindow({
      width: 1340,
      height: 880,
      title: cfg.appName,
      autoHideMenuBar: true,
      backgroundColor: '#111b21',
      webPreferences: {
        preload: path.join(__dirname, '..', 'shell-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWin.on('closed', () => {
      mainWin = null;
      accounts = null;
    });
    mainWin.loadFile(path.join(__dirname, '..', 'shell.html'));
    accounts = createAccountManager({
      win: mainWin,
      url: cfg.url,
      allowedHosts: cfg.allowedHosts,
      preload: cfg.preload,
      userAgent: ua,
      storage: accountStorage,
      openExternal: openExternalSafe,
      onChange: (st) => {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('acc:state', st);
          const cur = st.accounts.find((a) => a.id === st.activeId);
          const unread = st.accounts.reduce((n, a) => n + (a.unread || 0), 0);
          mainWin.setTitle((unread ? '(' + unread + ') ' : '') + cfg.appName + (cur && st.accounts.length > 1 ? ' - ' + cur.name : ''));
        }
      },
    });
    accounts.init().catch((err) => console.error('[accounts] init failed', err));
    return mainWin;
  }

  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.focus();
      return;
    }
    settingsWin = new BrowserWindow({
      width: 520,
      height: 780,
      title: T('设置 - ') + cfg.appName,
      parent: mainWin || undefined,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    settingsWin.on('closed', () => {
      settingsWin = null;
    });
    settingsWin.loadFile(path.join(__dirname, '..', 'settings.html'));
  }

  // ---- 更新：安装版用 electron-updater 自动下载，下载完提示重启安装；开发模式退回到“打开下载页” ----
  let updater = null;
  let manualCheck = false;
  function setupAutoUpdate() {
    if (!app.isPackaged || process.platform !== 'win32') return;
    try {
      updater = require('electron-updater').autoUpdater;
    } catch (_) {
      updater = null;
      return;
    }
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('update-available', (info) => {
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'info', title: T('发现新版本'), message: T('正在后台下载新版本 {0}，下载完会提示你重启安装。', info.version) });
    });
    updater.on('update-not-available', () => {
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'info', title: T('检查更新'), message: T('当前已是最新版本（{0}）', app.getVersion()) });
      manualCheck = false;
    });
    updater.on('error', (err) => {
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'warning', title: T('检查更新'), message: T('自动更新失败：{0}\n可以到 GitHub 手动下载。', err && err.message) });
      manualCheck = false;
    });
    updater.on('update-downloaded', async (info) => {
      manualCheck = false;
      const r = await dialog.showMessageBox(mainWin || undefined, {
        type: 'info',
        title: T('新版本已下载'),
        message: T('新版本 {0} 已下载好（当前 {1}）', info.version, app.getVersion()),
        detail: T('现在重启就会安装；选「稍后」则在你下次关闭应用时自动安装。'),
        buttons: [T('立即重启安装'), T('稍后')],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) updater.quitAndInstall();
    });
  }

  async function checkUpdate(silent) {
    if (updater) {
      manualCheck = !silent;
      try {
        await updater.checkForUpdates();
      } catch (_) {}
      return true;
    }
    if (!cfg.repo) return false;
    const win = mainWin || undefined;
    const cur = app.getVersion();
    try {
      const res = await fetch(`https://api.github.com/repos/${cfg.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': cfg.shortName },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const latest = String(data.tag_name || '').replace(/^v/, '');
      if (latest && compareVersions(latest, cur) > 0) {
        const r = await dialog.showMessageBox(win, {
          type: 'info',
          title: T('发现新版本'),
          message: T('新版本 {0} 可用（当前 {1}）', latest, cur),
          detail: T('点「下载」前往 GitHub 下载最新安装包。'),
          buttons: [T('下载'), T('稍后')],
          defaultId: 0,
          cancelId: 1,
        });
        if (r.response === 0) shell.openExternal(data.html_url || `https://github.com/${cfg.repo}/releases`);
        return true;
      }
      if (!silent) await dialog.showMessageBox(win, { type: 'info', title: T('检查更新'), message: T('当前已是最新版本（{0}）', cur) });
      return false;
    } catch (err) {
      if (!silent) await dialog.showMessageBox(win, { type: 'warning', title: T('检查更新'), message: T('检查失败：') + err.message });
      return false;
    }
  }

  // ---- IPC：主窗口（网页） ----
  const pageAll = { ...service.pageHandlers, ...extraHandlers };
  Object.keys(pageAll).forEach((ch) => handle(ch, isMainSender, (arg) => pageAll[ch](arg)));
  handle('tr:open-settings', isMainSender, () => {
    openSettings();
    return true;
  });
  // 往输入框写文字：Chromium 原生“全选 + 输入”，不碰剪贴板
  handle('tr:compose-insert', isMainSender, async ({ text }, e) => {
    const wc = e.sender;
    wc.selectAll();
    await sleep(15);
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
        wc.sendInputEvent({ type: 'char', keyCode: 'Return', modifiers: ['shift'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
        await sleep(30);
      }
      if (lines[i]) await wc.insertText(lines[i]);
      await sleep(10);
    }
    return true;
  });
  handle('tr:compose-enter', isMainSender, (arg, e) => {
    const wc = e.sender;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    return true;
  });

  function zoomActive(delta) {
    const wc = accounts && accounts.activeWebContents();
    if (!wc) return;
    wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta);
  }

  // ---- IPC：左侧账号栏 ----
  handle('acc:state', isShellSender, () => (accounts ? accounts.state() : { accounts: [], activeId: null }));
  handle('acc:switch', isShellSender, (id) => accounts.switchTo(id));
  handle('acc:add', isShellSender, (data) => accounts.add(data || {}));
  handle('acc:update', isShellSender, ({ id, ...data }) => accounts.update(id, data));
  handle('acc:remove', isShellSender, (id) => accounts.remove(id));
  handle('acc:move', isShellSender, ({ id, delta }) => accounts.move(id, delta));
  handle('acc:reload', isShellSender, (id) => accounts.reload(id));
  handle('acc:group-collapse', isShellSender, ({ name, collapsed }) => accounts.setGroupCollapsed(name, collapsed));
  handle('acc:group-rename', isShellSender, ({ name, newName }) => accounts.renameGroup(name, newName));
  handle('acc:group-move', isShellSender, ({ name, delta }) => accounts.moveGroup(name, delta));
  handle('acc:group-remove', isShellSender, (name) => accounts.removeGroup(name));
  handle('acc:group-add', isShellSender, (name) => accounts.addGroup(name));
  handle('acc:ui-lang', isShellSender, async () => (await service.load()).uiLang || 'zh');
  handle('acc:overlay', isShellSender, (on) => accounts.setOverlay(on));
  handle('acc:parse-proxy', isShellSender, ({ text, defaultType }) => proxyLib.parseProxyString(text, defaultType));
  handle('acc:open-settings', isShellSender, () => {
    openSettings();
    return true;
  });
  handle('acc:test-proxy', isShellSender, ({ proxy: p, accountId }) => {
    const cfgP = { ...(p || {}) };
    // 编辑已有账号时密码留空 = 用已保存的密码
    if (accountId && cfgP.username && !cfgP.password) {
      const saved = (accountStorage.load().accounts || []).find((a) => a.id === accountId);
      if (saved && saved.proxy && saved.proxy.username === cfgP.username) cfgP.password = saved.proxy.password || '';
    }
    return accounts.testProxy(cfgP);
  });

  // ---- IPC：设置窗口 ----
  const sh = service.settingsHandlers;
  handle('st:get', isSettingsSender, () => sh['st:get']({ appName: cfg.appName, version: app.getVersion(), canUpdate: true }));
  handle('st:set', isSettingsSender, (p) => sh['st:set'](p));
  handle('st:test', isSettingsSender, (p) => sh['st:test'](p));
  handle('st:test-stt', isSettingsSender, (p) => sh['st:test-stt'](p));
  handle('st:check-update', isSettingsSender, () => checkUpdate(false));

  // 菜单（界面语言切换后重建）
  function buildMenu() {
    Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: T('设置…'), accelerator: 'CmdOrCtrl+,', click: openSettings },
      {
        label: T('账号'),
        submenu: [
          ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
            label: T('切换到账号 {0}', n),
            accelerator: 'CmdOrCtrl+' + n,
            click: () => accounts && accounts.switchToIndex(n - 1),
          })),
          { type: 'separator' },
          { label: T('重新加载当前账号'), accelerator: 'CmdOrCtrl+R', click: () => accounts && accounts.reload() },
        ],
      },
      { label: T('检查更新…'), click: () => checkUpdate(false) },
      { role: 'editMenu' },
      {
        label: T('视图'),
        submenu: [
          { label: T('放大'), accelerator: 'CmdOrCtrl+=', click: () => zoomActive(0.5) },
          { label: T('缩小'), accelerator: 'CmdOrCtrl+-', click: () => zoomActive(-0.5) },
          { label: T('实际大小'), accelerator: 'CmdOrCtrl+0', click: () => zoomActive(0) },
          { type: 'separator' },
          {
            label: T('开发者工具（当前账号）'),
            accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
            click: () => {
              const wc = accounts && accounts.activeWebContents();
              if (wc) wc.toggleDevTools();
            },
          },
          { role: 'togglefullscreen', label: T('全屏') },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
  }

  // ---- 启动 ----
  app.whenReady().then(() => {
    service.load().then((st) => {
      lastUiLang = st.uiLang || 'zh';
      buildMenu();
    });
    buildMenu();
    createMainWindow();
    setupAutoUpdate();
    setTimeout(() => checkUpdate(true), 8000);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('before-quit', () => {
    service.flush();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  return { service };
}

module.exports = { createTranslatorApp, chromeUA };
