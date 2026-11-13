// Electron 主进程（Windows 桌面版）：窗口、菜单、托盘、更新、输入框写入/发送，以及把翻译服务接到 IPC 上
'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, shell, dialog, safeStorage, session, net, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const serviceLib = require('./service');
const { createService, compareVersions } = serviceLib;
const { createAccountManager } = require('./accounts');
const proxyLib = require('./proxy');
const lang = require('./lang');
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
// 先写临时文件再改名，写一半崩溃也不会损坏。Windows 上目标文件被杀毒软件短暂占用时会 EPERM，重试几次
function writeJSONFile(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) {
        /* 短暂等待 */
      }
    }
  }
  // 改名实在不行就直接覆盖写
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    fs.unlinkSync(tmp);
  } catch (_) {
    throw lastErr;
  }
}

function canEncrypt() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (_) {
    return false;
  }
}
function encryptStr(t) {
  return safeStorage.encryptString(String(t)).toString('base64');
}
function decryptStr(t) {
  return safeStorage.decryptString(Buffer.from(String(t), 'base64'));
}

// 这些文件里是聊天内容，整个文件加密保存（API Key 由 service 自己逐项加密）
const ENCRYPTED_FILES = new Set(['translation-cache', 'wingman-state', 'wingman-profiles']);

const fileStorage = {
  async loadJSON(name, fallback) {
    const raw = readJSONFile(userFile(name + '.json'), fallback);
    if (raw && typeof raw === 'object' && typeof raw.__enc === 'string') {
      if (!canEncrypt()) return fallback;
      try {
        return JSON.parse(decryptStr(raw.__enc));
      } catch (_) {
        return fallback;
      }
    }
    return raw;
  },
  async saveJSON(name, value) {
    if (ENCRYPTED_FILES.has(name) && canEncrypt()) writeJSONFile(userFile(name + '.json'), { __enc: encryptStr(JSON.stringify(value)) });
    else writeJSONFile(userFile(name + '.json'), value);
  },
  hashBytes(bytes) {
    return crypto.createHash('sha1').update(bytes).digest('hex');
  },
};
// API Key 用系统加密保存（Windows：DPAPI；Mac：钥匙串）
Object.defineProperty(fileStorage, 'encrypt', {
  get() {
    return canEncrypt() ? encryptStr : undefined;
  },
});
Object.defineProperty(fileStorage, 'decrypt', {
  get() {
    return canEncrypt() ? decryptStr : undefined;
  },
});

// Wingman 的聊天记录：每行一条 JSON，可用系统加密时逐行加密（以 "enc:" 开头），旧的明文行仍能读
const LOG_FILE = 'wingman-chatlog.jsonl';
function encodeLogLine(entry) {
  const json = JSON.stringify(entry);
  return (canEncrypt() ? 'enc:' + encryptStr(json) : json) + '\n';
}
const fileKV = {
  async readLog() {
    let lines = [];
    try {
      lines = fs.readFileSync(userFile(LOG_FILE), 'utf8').split('\n');
    } catch (_) {}
    const out = [];
    for (const l of lines) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l.startsWith('enc:') ? decryptStr(l.slice(4)) : l));
      } catch (_) {}
    }
    fileKV.lineCount = lines.filter(Boolean).length;
    return out;
  },
  async appendLog(entry) {
    fs.appendFileSync(userFile(LOG_FILE), encodeLogLine(entry));
    fileKV.lineCount = (fileKV.lineCount || 0) + 1;
  },
  // 用内存里的精简记录重写整个文件（去掉超出上限的旧消息），顺便把旧的明文行加密
  async rewriteLog(entries) {
    const file = userFile(LOG_FILE);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, entries.map(encodeLogLine).join(''));
    fs.renameSync(tmp, file);
    fileKV.lineCount = entries.length;
  },
  lineCount: 0,
  async get(name, fallback) {
    return fileStorage.loadJSON(name, fallback);
  },
  async set(name, value) {
    return fileStorage.saveJSON(name, value);
  },
};

// ---------------- API 请求：走独立代理的 fetch ----------------
// service 用 Node 的 fetch 不会经过 Electron 的代理设置，这里用 net.request + 专用 session 实现一个最小 fetch，
// 这样翻译 / 语音 / 识图请求可以统一走“设置 → API 请求代理”，而不是从本机直连出去。
const API_PARTITION = 'trx-api';
let apiProxyApplied = null;
async function applyApiProxy(p) {
  const key = JSON.stringify(proxyLib.proxyConfig(p));
  if (key === apiProxyApplied) return;
  const ses = session.fromPartition(API_PARTITION);
  await ses.setProxy(proxyLib.proxyConfig(p));
  if (ses.closeAllConnections) await ses.closeAllConnections();
  apiProxyApplied = key;
}

function buildMultipart(parts) {
  const boundary = '----trx' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const p of parts) {
    const name = String(p.name).replace(/"/g, '');
    if (p.bytes) {
      const fn = String(p.filename || 'file').replace(/"/g, '');
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fn}"\r\nContent-Type: ${p.type || 'application/octet-stream'}\r\n\r\n`));
      chunks.push(Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(p.value)}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary };
}

function makeApiFetch(getProxy) {
  return async function apiFetch(url, init) {
    const p = getProxy();
    await applyApiProxy(p); // 直连 / 跟随系统 / 固定代理
    const headers = { ...(init.headers || {}) };
    let body = init.body;
    if (body && typeof body === 'object' && Array.isArray(body.parts)) {
      const mp = buildMultipart(body.parts);
      body = mp.body;
      headers['Content-Type'] = mp.contentType;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const req = net.request({
        url,
        method: init.method || 'GET',
        session: session.fromPartition(API_PARTITION),
        useSessionCookies: false,
        credentials: 'omit',
      });
      Object.keys(headers).forEach((k) => req.setHeader(k, headers[k]));
      let authTries = 0;
      req.on('login', (authInfo, callback) => {
        if (authInfo && authInfo.isProxy && p && p.username && authTries++ < 1) callback(p.username, p.password || '');
        else callback();
      });
      if (init.signal) {
        const onAbort = () => {
          try {
            req.abort();
          } catch (_) {}
          const e = new Error('aborted');
          e.name = 'AbortError';
          fail(e);
        };
        if (init.signal.aborted) return onAbort();
        init.signal.addEventListener('abort', onAbort, { once: true });
      }
      req.on('response', (res) => {
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const buf = Buffer.concat(bufs);
          const status = res.statusCode;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: res.headers,
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          });
        });
      });
      req.on('error', (err) => {
        const e = new Error(String((err && err.message) || err));
        e.cause = { code: /PROXY|TUNNEL|SOCKS/i.test(e.message) ? 'PROXY: ' + e.message : e.message };
        fail(e);
      });
      if (body) req.write(typeof body === 'string' ? body : Buffer.from(body));
      req.end();
    });
  };
}

// ---------------- 应用 ----------------
function createTranslatorApp(cfg) {
  // cfg: { appName, shortName, url, allowedHosts, repo, preload, extraDefaults, extraPageKeys, createExtras(service, kv) → handlers }
  let mainWin = null;
  let settingsWin = null;
  let tray = null;
  let quitting = false;
  let lastUiLang = 'zh';
  let accounts = null; // 多账号管理器（每个账号独立登录数据 + 独立代理）

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => showMain());

  const service = createService({
    appVersion: app.getVersion(),
    storage: fileStorage,
    extraDefaults: cfg.extraDefaults,
    extraPageKeys: cfg.extraPageKeys,
    onSettingsChanged: (view) => {
      if (accounts) {
        // 每个账号拿到带自己覆盖项的视图
        accounts.allWebContents().forEach((wc) => {
          service
            .publicView(accounts.overridesFor(wc))
            .then((v) => !wc.isDestroyed() && wc.send('tr:settings-changed', v))
            .catch(() => {});
        });
      }
      if (view.uiLang !== lastUiLang) {
        lastUiLang = view.uiLang;
        buildMenu();
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('acc:ui-lang', view.uiLang);
        if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(T('设置 - ') + cfg.appName);
      }
      updateTray();
    },
  });
  // 翻译 / 语音 / 识图请求走“API 请求代理”设置
  let currentApiProxy = { type: 'none' };
  serviceLib.setFetch(makeApiFetch(() => currentApiProxy));
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
    if (/^(https?:|mailto:|tel:)/i.test(String(url || ''))) shell.openExternal(String(url));
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

  function showMain() {
    if (!mainWin || mainWin.isDestroyed()) {
      createMainWindow();
      return;
    }
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }

  function createMainWindow() {
    const ua = chromeUA();
    mainWin = new BrowserWindow({
      width: 1340,
      height: 880,
      title: cfg.appName,
      autoHideMenuBar: true,
      backgroundColor: '#111b21',
      icon: cfg.icon,
      webPreferences: {
        preload: path.join(__dirname, '..', 'shell-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // 关闭窗口：缩到托盘（可在设置里关掉）
    mainWin.on('close', (e) => {
      if (quitting || process.platform === 'darwin') return;
      const s = service.settingsSync ? service.settingsSync() : null;
      if (s && s.closeToTray === false) return;
      if (!tray) return;
      e.preventDefault();
      mainWin.hide();
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
      pathPrefix: cfg.pathPrefix,
      preload: cfg.preload,
      userAgent: ua,
      storage: accountStorage,
      openExternal: openExternalSafe,
      onChange: (st) => {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('acc:state', withShellMeta(st));
          const cur = st.accounts.find((a) => a.id === st.activeId);
          const unread = st.accounts.reduce((n, a) => n + (a.unread || 0), 0);
          mainWin.setTitle((unread ? '(' + unread + ') ' : '') + cfg.appName + (cur && st.accounts.length > 1 ? ' - ' + cur.name : ''));
          updateTray(unread);
        }
      },
      onAccountChanged: (acc) => {
        // 账号级覆盖变了 → 通知这个账号的页面
        const wc = accounts && accounts.webContentsFor(acc.id);
        if (wc && !wc.isDestroyed())
          service
            .publicView(accounts.overridesFor(wc))
            .then((v) => !wc.isDestroyed() && wc.send('tr:settings-changed', v))
            .catch(() => {});
      },
    });
    accounts.init().catch((err) => console.error('[accounts] init failed', err));
    return mainWin;
  }

  // 账号栏除了账号列表还需要：语言列表、引擎列表、语气列表（用于账号级覆盖的下拉框）
  function withShellMeta(st) {
    return {
      ...st,
      languages: lang.LANGUAGES,
      engines: Object.fromEntries(Object.entries(serviceLib.ENGINE_PRESETS).map(([k, v]) => [k, v.label])),
      tones: Object.fromEntries(Object.entries(serviceLib.TONES).map(([k, v]) => [k, v.label])),
    };
  }

  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.focus();
      return;
    }
    settingsWin = new BrowserWindow({
      width: 540,
      height: 820,
      title: T('设置 - ') + cfg.appName,
      parent: mainWin && !mainWin.isDestroyed() && mainWin.isVisible() ? mainWin : undefined,
      autoHideMenuBar: true,
      icon: cfg.icon,
      webPreferences: {
        preload: path.join(__dirname, '..', 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    settingsWin.on('closed', () => {
      settingsWin = null;
    });
    settingsWin.loadFile(path.join(__dirname, '..', 'settings.html'));
  }

  // ---- 托盘 ----
  function trayIcon() {
    try {
      if (cfg.icon && fs.existsSync(cfg.icon)) {
        const img = nativeImage.createFromPath(cfg.icon);
        if (!img.isEmpty()) return process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img;
      }
    } catch (_) {}
    return nativeImage.createEmpty();
  }
  function setupTray() {
    if (tray || process.platform === 'darwin') return;
    try {
      tray = new Tray(trayIcon());
    } catch (err) {
      console.error('[tray] failed', err);
      tray = null;
      return;
    }
    tray.on('click', () => showMain());
    tray.on('double-click', () => showMain());
    updateTray();
  }
  function updateTray(unreadArg) {
    if (!tray) return;
    const st = accounts ? accounts.state() : { accounts: [] };
    const unread = unreadArg !== undefined ? unreadArg : st.accounts.reduce((n, a) => n + (a.unread || 0), 0);
    tray.setToolTip((unread ? '(' + unread + ') ' : '') + cfg.appName);
    const accItems = st.accounts.map((a) => ({
      label: (a.unread ? '(' + a.unread + ') ' : '') + a.name,
      type: 'radio',
      checked: a.id === st.activeId,
      click: () => {
        showMain();
        if (accounts) accounts.switchTo(a.id);
      },
    }));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: T('显示窗口'), click: () => showMain() },
        ...(accItems.length > 1 ? [{ type: 'separator' }, ...accItems] : []),
        { type: 'separator' },
        { label: T('设置…'), click: () => openSettings() },
        { label: T('检查更新…'), click: () => checkUpdate(false) },
        { type: 'separator' },
        {
          label: T('退出'),
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
  }

  // ---- 系统通知：新消息的译文 ----
  const notifiedRecently = new Map(); // key → ts，避免同一条消息反复弹
  function notifyTranslated({ title, body, accountId }) {
    if (!Notification.isSupported()) return false;
    const focused = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused();
    if (focused && accounts && accounts.state().activeId === accountId) return false;
    const key = accountId + '|' + title + '|' + body;
    const now = Date.now();
    for (const [k, t] of notifiedRecently) if (now - t > 60000) notifiedRecently.delete(k);
    if (notifiedRecently.has(key)) return false;
    notifiedRecently.set(key, now);
    const n = new Notification({ title: String(title || cfg.appName).slice(0, 80), body: String(body || '').slice(0, 300), silent: false, icon: cfg.icon });
    n.on('click', () => {
      showMain();
      if (accounts && accountId) accounts.switchTo(accountId);
    });
    n.show();
    return true;
  }

  // ---- 更新 ----
  // 这是一个“防止中文误发”的工具，旧版本留在电脑上就是漏洞，所以更新尽量不靠人点：
  //   · 启动时、之后每 3 小时检查一次（软件常年开着不关也能发现新版本）
  //   · 发现新版本直接在后台下载
  //   · 下载好后提示安装（默认按钮就是“立即安装”）；选了“稍后”：30 分钟后再提醒，
  //     电脑空闲 5 分钟以上时自动安装并重启，退出软件时也会自动装上
  let updater = null;
  let manualCheck = false;
  let updateInfo = null;
  let downloading = false;
  let pendingUpdate = null; // 已下载好、等待安装的版本
  let updatePromptOpen = false;
  let updateRemindTimer = null;
  function installUpdateNow() {
    if (!updater || !pendingUpdate) return;
    quitting = true;
    try {
      updater.quitAndInstall(true, true); // 静默安装，装完自动重新打开
    } catch (_) {
      quitting = false;
    }
  }
  async function promptInstallUpdate() {
    if (!pendingUpdate || updatePromptOpen) return;
    updatePromptOpen = true;
    let r = { response: 1 };
    try {
      r = await dialog.showMessageBox(mainWin && !mainWin.isDestroyed() ? mainWin : undefined, {
        type: 'info',
        title: T('新版本已下载'),
        message: T('新版本 {0} 已下载好，包含防止中文误发的重要修复。', pendingUpdate.version),
        detail: T('现在安装吗？选「30 分钟后提醒」的话，电脑空闲时或退出软件时会自动安装。'),
        buttons: [T('立即重启安装（约半分钟）'), T('30 分钟后提醒')],
        defaultId: 0,
        cancelId: 1,
      });
    } catch (_) {}
    updatePromptOpen = false;
    if (r.response === 0) return installUpdateNow();
    clearTimeout(updateRemindTimer);
    updateRemindTimer = setTimeout(promptInstallUpdate, 30 * 60 * 1000);
  }
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
    updater.allowDowngrade = false;
    updater.on('update-available', (info) => {
      updateInfo = info;
      downloading = true;
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'info', title: T('发现新版本'), message: T('新版本 {0} 可用（当前 {1}）', info.version, app.getVersion()), detail: T('正在后台下载，下载好会提示安装。') });
      manualCheck = false;
    });
    updater.on('update-not-available', () => {
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'info', title: T('检查更新'), message: T('当前已是最新版本（{0}）', app.getVersion()) });
      manualCheck = false;
    });
    updater.on('error', (err) => {
      downloading = false;
      if (manualCheck) dialog.showMessageBox(mainWin || undefined, { type: 'warning', title: T('检查更新'), message: T('自动更新失败：{0}\n可以到 GitHub 手动下载。', err && err.message) });
      manualCheck = false;
    });
    updater.on('update-downloaded', (info) => {
      downloading = false;
      manualCheck = false;
      pendingUpdate = info;
      promptInstallUpdate();
    });
    // 软件一直开着不关的话，每 3 小时检查一次
    setInterval(() => checkUpdate(true), 3 * 3600 * 1000);
    // 新版本已下载好、电脑空闲 5 分钟以上 → 自动安装并重启（不打断正在聊天的人）
    setInterval(() => {
      if (!pendingUpdate) return;
      try {
        const { powerMonitor } = require('electron');
        if (powerMonitor.getSystemIdleTime() >= 300) installUpdateNow();
      } catch (_) {}
    }, 60 * 1000);
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
        // 只打开 GitHub 自己的地址
        const pageUrl = /^https:\/\/github\.com\//.test(String(data.html_url || '')) ? data.html_url : `https://github.com/${cfg.repo}/releases`;
        if (r.response === 0) openExternalSafe(pageUrl);
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
  // 每个处理函数都拿到“发起请求的账号”的覆盖项（语言 / 语气 / 引擎）
  const pageAll = { ...service.pageHandlers, ...extraHandlers };
  Object.keys(pageAll).forEach((ch) => handle(ch, isMainSender, (arg, e) => pageAll[ch](arg, accounts ? accounts.overridesFor(e.sender) : null)));
  handle('tr:open-settings', isMainSender, () => {
    openSettings();
    return true;
  });
  // 页面侧的诊断日志（比如“这次发送为什么没翻译”）写到 userData/translator.log，超过 1MB 轮转一次
  handle('tr:log', isMainSender, (entry, e) => {
    try {
      const file = userFile('translator.log');
      try {
        if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1');
      } catch (_) {}
      const acc = accounts && accounts.accountForSender(e);
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), acc: acc ? acc.name : '', ...(entry || {}) }) + '\n');
    } catch (_) {}
    return true;
  });
  handle('tr:notify', isMainSender, async ({ title, body }, e) => {
    const s = await service.load();
    if (s.notifyTranslated === false) return false;
    const acc = accounts && accounts.accountForSender(e);
    return notifyTranslated({ title: (acc && accounts.state().accounts.length > 1 ? '[' + acc.name + '] ' : '') + String(title || ''), body, accountId: acc && acc.id });
  });
  // 往输入框写文字：Chromium 原生“全选 + 输入”，不碰剪贴板
  handle('tr:compose-insert', isMainSender, async ({ text }, e) => {
    const wc = e.sender;
    wc.selectAll();
    await sleep(15);
    if (!String(text || '')) {
      // 清空输入框
      wc.delete();
      return true;
    }
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
  // 按“发送键”：根据设置是回车还是 Ctrl+回车
  handle('tr:compose-enter', isMainSender, async (arg, e) => {
    const wc = e.sender;
    const s = await service.load();
    const mods = s.sendKey === 'ctrlEnter' ? ['control'] : [];
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: mods });
    wc.sendInputEvent({ type: 'char', keyCode: 'Return', modifiers: mods });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: mods });
    return true;
  });

  function zoomActive(delta) {
    const wc = accounts && accounts.activeWebContents();
    if (!wc) return;
    wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta);
  }

  // ---- IPC：左侧账号栏 ----
  const needAccounts = (fn) => (arg) => {
    if (!accounts) throw new Error(T('窗口未就绪'));
    return fn(arg);
  };
  handle('acc:state', isShellSender, () => withShellMeta(accounts ? accounts.state() : { accounts: [], groups: [], activeId: null }));
  handle('acc:switch', isShellSender, needAccounts((id) => accounts.switchTo(id)));
  handle('acc:add', isShellSender, needAccounts((data) => accounts.add(data || {})));
  handle('acc:update', isShellSender, needAccounts(({ id, ...data }) => accounts.update(id, data)));
  handle('acc:remove', isShellSender, needAccounts((id) => accounts.remove(id)));
  handle('acc:move', isShellSender, needAccounts(({ id, delta }) => accounts.move(id, delta)));
  handle('acc:reload', isShellSender, needAccounts((id) => accounts.reload(id)));
  handle('acc:check-ip', isShellSender, needAccounts((id) => accounts.checkAccountIP(id)));
  handle('acc:group-collapse', isShellSender, needAccounts(({ name, collapsed }) => accounts.setGroupCollapsed(name, collapsed)));
  handle('acc:group-rename', isShellSender, needAccounts(({ name, newName }) => accounts.renameGroup(name, newName)));
  handle('acc:group-move', isShellSender, needAccounts(({ name, delta }) => accounts.moveGroup(name, delta)));
  handle('acc:group-remove', isShellSender, needAccounts((name) => accounts.removeGroup(name)));
  handle('acc:group-add', isShellSender, needAccounts((name) => accounts.addGroup(name)));
  handle('acc:ui-lang', isShellSender, async () => (await service.load()).uiLang || 'zh');
  handle('acc:overlay', isShellSender, needAccounts((on) => accounts.setOverlay(on)));
  handle('acc:parse-proxy', isShellSender, ({ text, defaultType }) => proxyLib.parseProxyString(text, defaultType));
  handle('acc:open-settings', isShellSender, () => {
    openSettings();
    return true;
  });
  handle(
    'acc:test-proxy',
    isShellSender,
    needAccounts(({ proxy: p, accountId }) => {
      const cfgP = { ...(p || {}) };
      // 编辑已有账号时密码留空 = 用已保存的密码
      if (accountId && cfgP.username && !cfgP.password) {
        const saved = (accountStorage.load().accounts || []).find((a) => a.id === accountId);
        if (saved && saved.proxy && saved.proxy.username === cfgP.username) cfgP.password = saved.proxy.password || '';
      }
      return accounts.testProxy(cfgP);
    })
  );

  // ---- IPC：设置窗口 ----
  const sh = service.settingsHandlers;
  handle('st:get', isSettingsSender, () => sh['st:get']({ appName: cfg.appName, version: app.getVersion(), canUpdate: true, isDesktop: true }));
  handle('st:set', isSettingsSender, async (p) => {
    const r = await sh['st:set'](p);
    const s = await service.load();
    currentApiProxy = s.apiProxy || { type: 'none' };
    return r;
  });
  handle('st:test', isSettingsSender, async (p) => {
    // 测试时也用页面上填的代理（密码留空 = 用已保存的）
    const prev = currentApiProxy;
    if (p && p.apiProxy) {
      const ap = { ...p.apiProxy };
      if (ap.username && !ap.password && prev && prev.username === ap.username) ap.password = prev.password;
      currentApiProxy = ap;
    }
    try {
      return await sh['st:test'](p);
    } finally {
      currentApiProxy = prev;
    }
  });
  handle('st:test-stt', isSettingsSender, (p) => sh['st:test-stt'](p));
  handle('st:test-tts', isSettingsSender, (p) => sh['st:test-tts'](p));
  handle('st:tts-voices', isSettingsSender, (p) => sh['st:tts-voices'](p));
  handle('st:clone-voice', isSettingsSender, (p) => sh['st:clone-voice'](p));
  handle('st:delete-cloned-voice', isSettingsSender, () => sh['st:delete-cloned-voice']());
  handle('st:test-api-proxy', isSettingsSender, async (p) => {
    const ap = { ...(p || {}) };
    if (ap.username && !ap.password && currentApiProxy && currentApiProxy.username === ap.username) ap.password = currentApiProxy.password;
    const bad = proxyLib.validateProxy(ap);
    if (bad) throw new Error(bad);
    if (!accounts) throw new Error(T('窗口未就绪'));
    return accounts.testProxy(ap);
  });
  handle('st:check-update', isSettingsSender, () => checkUpdate(false));
  handle('st:clear-cache', isSettingsSender, async () => {
    await sh['st:clear-cache']();
    // 聊天助手的记录 / 状态 / 档案也一起清
    for (const f of [LOG_FILE, 'wingman-state.json', 'wingman-profiles.json']) {
      try {
        fs.unlinkSync(userFile(f));
      } catch (_) {}
    }
    if (extraHandlers['wm:reset']) await extraHandlers['wm:reset']();
    return true;
  });

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
        ...(process.platform !== 'darwin'
          ? [
              {
                label: T('退出'),
                accelerator: 'CmdOrCtrl+Q',
                click: () => {
                  quitting = true;
                  app.quit();
                },
              },
            ]
          : []),
      ])
    );
  }

  // ---- 启动 ----
  app.whenReady().then(async () => {
    const st = await service.load();
    lastUiLang = st.uiLang || 'zh';
    currentApiProxy = st.apiProxy || { type: 'none' };
    buildMenu();
    createMainWindow();
    setupTray();
    setupAutoUpdate();
    setTimeout(() => checkUpdate(true), 8000);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      else showMain();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    service.flush();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  return { service };
}

module.exports = { createTranslatorApp, chromeUA };
