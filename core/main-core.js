// Electron 主进程（Windows 桌面版）：窗口、菜单、自动更新、输入框写入/发送，以及把翻译服务接到 IPC 上
'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createService, compareVersions } = require('./service');

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
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('tr:settings-changed', view);
    },
  });
  const extraHandlers = cfg.createExtras ? cfg.createExtras(service, fileKV) : {};

  const isMainSender = (e) => mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents;
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

  function createMainWindow() {
    const ua = chromeUA();
    mainWin = new BrowserWindow({
      width: 1280,
      height: 860,
      title: cfg.appName,
      autoHideMenuBar: true,
      webPreferences: {
        preload: cfg.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // preload 需要 require 本地模块；网页本身仍然没有 Node 权限
        spellcheck: false,
      },
    });
    const wc = mainWin.webContents;
    wc.setUserAgent(ua);
    wc.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      try {
        if (!cfg.allowedHosts.includes(new URL(url).host)) {
          e.preventDefault();
          openExternalSafe(url);
        }
      } catch (_) {}
    });
    mainWin.on('closed', () => {
      mainWin = null;
    });
    mainWin.loadURL(cfg.url, { userAgent: ua });
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
      title: '设置 - ' + cfg.appName,
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
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'info', title: '发现新版本', message: `正在后台下载新版本 ${info.version}，下载完会提示你重启安装。` });
    });
    updater.on('update-not-available', () => {
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'info', title: '检查更新', message: `当前已是最新版本（${app.getVersion()}）` });
      manualCheck = false;
    });
    updater.on('error', (err) => {
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'warning', title: '检查更新', message: '自动更新失败：' + (err && err.message) + '\n可以到 GitHub 手动下载。' });
      manualCheck = false;
    });
    updater.on('update-downloaded', async (info) => {
      manualCheck = false;
      const r = await dialog.showMessageBox(mainWin || undefined, {
        type: 'info',
        title: '新版本已下载',
        message: `新版本 ${info.version} 已下载好（当前 ${app.getVersion()}）`,
        detail: '现在重启就会安装；选「稍后」则在你下次关闭应用时自动安装。',
        buttons: ['立即重启安装', '稍后'],
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
          title: '发现新版本',
          message: `新版本 ${latest} 可用（当前 ${cur}）`,
          detail: '点「下载」前往 GitHub 下载最新安装包。',
          buttons: ['下载', '稍后'],
          defaultId: 0,
          cancelId: 1,
        });
        if (r.response === 0) shell.openExternal(data.html_url || `https://github.com/${cfg.repo}/releases`);
        return true;
      }
      if (!silent) await dialog.showMessageBox(win, { type: 'info', title: '检查更新', message: `当前已是最新版本（${cur}）` });
      return false;
    } catch (err) {
      if (!silent) await dialog.showMessageBox(win, { type: 'warning', title: '检查更新', message: '检查失败：' + err.message });
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

  // ---- IPC：设置窗口 ----
  const sh = service.settingsHandlers;
  handle('st:get', isSettingsSender, () => sh['st:get']({ appName: cfg.appName, version: app.getVersion(), canUpdate: true }));
  handle('st:set', isSettingsSender, (p) => sh['st:set'](p));
  handle('st:test', isSettingsSender, (p) => sh['st:test'](p));
  handle('st:check-update', isSettingsSender, () => checkUpdate(false));

  // ---- 启动 ----
  app.whenReady().then(() => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { label: '检查更新…', click: () => checkUpdate(false) },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ])
    );
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
