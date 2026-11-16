// 多账号：每个账号一个独立的登录数据（session 分区）和独立的代理；窗口左侧是账号栏（shell.html）
'use strict';

const { WebContentsView, session, net, app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const proxy = require('./proxy');
const { AUTO_OPEN_EXT, DANGER_EXT, fileExt, cleanFileName, uniquePath, releasePath } = require('./files');
const { T } = require('./i18n');

const lang = require('./lang');

const SIDEBAR_WIDTH = 68;
const COLORS = ['#00a884', '#6d3b8f', '#d43f81', '#0984e3', '#e17055', '#00b894', '#fdcb6e', '#636e72'];
// 聊天页面允许申请的权限（WhatsApp / Telegram 通话、语音、通知、剪贴板）；其他一律拒绝
const ALLOWED_PERMISSIONS = new Set(['media', 'audioCapture', 'videoCapture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'display-capture', 'speaker-selection', 'mediaKeySystem']);
const ENGINES = ['deepseek', 'openai', 'gemini', 'custom'];
const TONES = ['casual', 'formal', 'warm', 'brief'];

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * opts: {
 *   win, url, allowedHosts, preload, userAgent,
 *   pathPrefix,   // 可选：只允许这个路径下的页面（Telegram 只支持 /k；A 版网页上翻译和护栏都不工作）
 *   storage: { load() → {accounts, activeId}, save(data) },  // 已解密 / 由宿主加密
 *   log(entry),   // 可选：诊断记录（写到 translator.log）
 *   openExternal(url), onChange(state), onAccountChanged(acc)
 * }
 */
function createAccountManager(opts) {
  let accounts = [];
  let groups = []; // [{ name, collapsed }]，按显示顺序；账号的 group 为空 = 未分组
  let activeId = null;
  let overlay = false; // 账号栏弹出编辑框时，临时隐藏网页
  const views = new Map(); // id → { view, unread }
  const ipCache = new Map(); // id → { ip, place, at, error }

  function sessionFor(acc) {
    return acc.partition ? session.fromPartition(acc.partition) : session.defaultSession;
  }

  function publicAccount(acc) {
    const v = views.get(acc.id);
    const p = acc.proxy || {};
    return {
      id: acc.id,
      name: acc.name,
      color: acc.color,
      proxy: { type: p.type || 'none', host: p.host || '', port: p.port || '', username: p.username || '', hasPassword: !!p.password },
      proxyLabel: proxy.proxyLabel(p),
      group: acc.group || '',
      unread: v ? v.unread : 0,
      ip: ipCache.get(acc.id) || null,
      // 账号级覆盖（空 = 跟随全局设置）
      engine: acc.engine || '',
      defaultTheirLang: acc.defaultTheirLang || '',
      tone: acc.tone || '',
      error: v && v.error ? v.error : '',
    };
  }

  // 给翻译服务用的覆盖项
  function overridesOf(acc) {
    if (!acc) return null;
    const o = {};
    if (acc.engine) o.engine = acc.engine;
    if (acc.defaultTheirLang) o.defaultTheirLang = acc.defaultTheirLang;
    if (acc.tone) o.tone = acc.tone;
    return Object.keys(o).length ? o : null;
  }
  function cleanOverrides(data, acc) {
    if (data.engine !== undefined) acc.engine = ENGINES.includes(data.engine) ? data.engine : '';
    if (data.defaultTheirLang !== undefined) acc.defaultTheirLang = lang.LANG_NAMES.has(data.defaultTheirLang) ? data.defaultTheirLang : '';
    if (data.tone !== undefined) acc.tone = TONES.includes(data.tone) ? data.tone : '';
  }

  // ---- 分组 ----
  function cleanGroupName(g) {
    return String(g || '').trim().slice(0, 40);
  }
  function ensureGroup(name) {
    if (name && !groups.some((g) => g.name === name)) groups.push({ name, collapsed: false });
  }
  // 显示顺序：未分组的在最上面，然后按分组顺序；组内按添加顺序
  function displayOrder() {
    const out = accounts.filter((a) => !a.group);
    for (const g of groups) out.push(...accounts.filter((a) => a.group === g.name));
    // 兜底：分组列表里没有的组
    for (const a of accounts) if (!out.includes(a)) out.push(a);
    return out;
  }

  function state() {
    return {
      accounts: displayOrder().map(publicAccount),
      groups: groups.map((g) => ({ name: g.name, collapsed: !!g.collapsed, count: accounts.filter((a) => a.group === g.name).length })),
      activeId,
      sidebarWidth: SIDEBAR_WIDTH,
    };
  }

  function emit() {
    if (opts.onChange) opts.onChange(state());
  }

  function persist() {
    opts.storage.save({ accounts, activeId, groups });
  }

  // ---- 布局 ----
  function layout() {
    if (!opts.win || opts.win.isDestroyed()) return;
    const [w, h] = opts.win.getContentSize();
    for (const [id, v] of views) {
      v.view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, w - SIDEBAR_WIDTH), height: h });
      v.view.setVisible(!overlay && id === activeId);
    }
  }

  // ---- 创建网页 ----
  async function applyProxy(acc) {
    const ses = sessionFor(acc);
    await ses.setProxy(proxy.proxyConfig(acc.proxy));
    if (ses.closeAllConnections) await ses.closeAllConnections();
  }

  // ---- 诊断记录（写到 translator.log）----
  // 文件为什么没打开、哪个权限被拒了、哪个跳转被拦了……出了问题时靠它判断。
  // 只记“类型 / 扩展名 / 网站域名 / 大小”，不记文件名、网址全文和聊天内容；同一类事情每次运行只记有限的几条
  const diagCount = new Map();
  function diag(ev, data, limit, wc) {
    try {
      if (!opts.log) return;
      if (!diagCount.has(ev) && diagCount.size >= 300) return;
      const n = (diagCount.get(ev) || 0) + 1;
      diagCount.set(ev, n);
      if (n > (limit || 40)) return;
      let acc = '';
      if (wc) for (const [id, v] of views) if (v.view.webContents === wc) acc = (accounts.find((a) => a.id === id) || {}).name || '';
      opts.log({ acc, kind: 'file', ev, ...(data || {}) });
    } catch (_) {}
  }
  // 网址只留“协议 + 域名”
  function siteOf(url) {
    try {
      const str = String(url || '');
      if (/^blob:/i.test(str)) return 'blob:' + new URL(str.slice(5)).host;
      const u = new URL(str);
      return u.protocol + '//' + u.host;
    } catch (_) {
      return String(url || '').slice(0, 12);
    }
  }

  // ---- 下载 / 打开文件 ----
  // 聊天网站自己生成的 blob: 地址（网页里“打开 / 下载文件”常用）
  function ownBlob(url) {
    try {
      if (!/^blob:/i.test(String(url))) return false;
      const inner = new URL(String(url).slice(5));
      return inner.protocol === 'https:' && opts.allowedHosts.includes(inner.host);
    } catch (_) {
      return false;
    }
  }

  // 在聊天页面上弹一条提示；找不到是哪个页面发起的（比如隐藏的小框架）就提示给当前账号
  // file：这条提示说的是哪个文件——页面会给出“打开 / 打开文件夹”按钮（按钮点回来时只认我们自己记下的编号，不认路径）
  const savedFiles = new Map(); // 编号 → 文件路径
  function toastTo(wc, text, type, file) {
    let target = wc && !wc.isDestroyed() ? wc : null;
    if (!target || !Array.from(views.values()).some((v) => v.view.webContents === target)) {
      const v = views.get(activeId);
      target = v ? v.view.webContents : null;
    }
    const msg = { text, type: type || '', ms: file ? 10000 : 8000 };
    if (file) {
      const id = newId();
      savedFiles.set(id, file);
      while (savedFiles.size > 200) savedFiles.delete(savedFiles.keys().next().value);
      msg.file = { id, open: !DANGER_EXT.has(fileExt(file)) };
    }
    try {
      if (target && !target.isDestroyed()) target.send('tr:host-toast', msg);
    } catch (_) {}
  }
  // 提示上的按钮：打开文件 / 在文件夹里显示
  function fileAction(arg) {
    const file = savedFiles.get(String((arg && arg.id) || ''));
    if (!file || !fs.existsSync(file)) return false;
    if (arg.what === 'open' && !DANGER_EXT.has(fileExt(file))) Promise.resolve(shell.openPath(file)).catch(() => {});
    else shell.showItemInFolder(file);
    return true;
  }

  // 自动打开文档。同一个文件短时间内只打开一次：员工习惯双击，网页也可能同一个文件连着发起两次下载
  let lastOpened = { key: '', at: 0 };
  function openDoc(file) {
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch (_) {}
    const key = fileExt(file) + ':' + size;
    const now = Date.now();
    if (key === lastOpened.key && now - lastOpened.at < 3000) return false; // 同类型、同大小、3 秒内刚打开过
    lastOpened = { key, at: now };
    // 系统里没有能打开它的程序时，退一步在文件夹里显示
    Promise.resolve(shell.openPath(file))
      .then((err) => {
        if (err) shell.showItemInFolder(file);
      })
      .catch(() => {});
    return true;
  }

  // 网页想在新窗口 / 整个页面打开自己生成的文件（blob: 地址）→ 我们替它下载。
  // 稍等一下再动手：有的网页发现新窗口没开成，会马上自己再下载一次（那一次带着正确的文件名），那就用它的，不重复下
  const pendingBlob = new Map(); // blob 地址 → 定时器
  function downloadBlobSoon(wc, url, how) {
    if (pendingBlob.has(url)) return; // 连点两下：同一个地址只下一次
    diag('blob-open', { how }, 40, wc);
    pendingBlob.set(
      url,
      setTimeout(() => {
        pendingBlob.delete(url);
        try {
          if (!wc.isDestroyed()) wc.downloadURL(url);
        } catch (_) {}
      }, 250)
    );
  }

  // 点开 PDF / 文档 / 图片原图时网页会发起下载。不弹“另存为”（员工反馈点了没反应、一直转圈），
  // 直接存到系统的“下载”文件夹；存好后常见文档自动用默认程序打开，其它类型在提示上给“打开 / 打开文件夹”按钮
  function onDownload(item, wc) {
    // 网页自己已经在下载这个文件了，我们就不用再替它下
    try {
      const waiting = pendingBlob.get(item.getURL());
      if (waiting) {
        clearTimeout(waiting);
        pendingBlob.delete(item.getURL());
      }
    } catch (_) {}
    let file = '';
    try {
      let dir = '';
      try {
        dir = app.getPath('downloads');
      } catch (_) {}
      if (!dir) dir = app.getPath('temp');
      fs.mkdirSync(dir, { recursive: true });
      file = uniquePath(dir, cleanFileName(item.getFilename(), item.getMimeType()));
      item.setSavePath(file);
    } catch (err) {
      diag('download-nopath', { err: String((err && err.message) || err).slice(0, 80) }, 10, wc);
      return; // 定不了保存位置：交回给系统默认的“另存为”
    }
    const name = path.basename(file);
    const from = siteOf(item.getURL());
    item.once('done', (e, state) => {
      releasePath(file);
      let opened = false;
      if (state === 'completed') {
        if (AUTO_OPEN_EXT.has(fileExt(file)) && (opened = openDoc(file))) toastTo(wc, T('已下载并打开：{0}（保存在“下载”文件夹）', name), '', file);
        else if (DANGER_EXT.has(fileExt(file))) toastTo(wc, T('已下载：{0}（这类文件不会自动打开，请确认来源可靠再运行）', name), 'warn', file);
        else toastTo(wc, T('已保存到“下载”文件夹：{0}', name), '', file);
      } else if (state !== 'cancelled') toastTo(wc, T('文件没有下载成功：{0}', name), 'error');
      let bytes = -1;
      try {
        bytes = item.getReceivedBytes();
      } catch (_) {}
      diag('download', { state, ext: fileExt(file), bytes, opened, from }, 60, wc);
    });
  }

  // 网页用文件系统接口保存文件（用户已经在“另存为”里选好了位置）：等它写完，常见文档自动打开。
  // Chromium 先写到旁边的 .crswap 临时文件，关闭时才换成正式文件——所以“正式文件有内容了、临时文件没了”就是写完了
  const watchedSaves = new Map(); // 路径 → 定时器
  function noteSavedFile(details, wc) {
    const file = details && details.fileAccessType === 'writable' && typeof details.filePath === 'string' ? details.filePath : '';
    if (!file || watchedSaves.has(file)) return;
    if (!AUTO_OPEN_EXT.has(fileExt(file))) return;
    diag('fs-save', { ext: fileExt(file) }, 40, wc);
    const stat = () => {
      try {
        const st = fs.statSync(file);
        return { size: st.size, mtime: st.mtimeMs };
      } catch (_) {
        return { size: 0, mtime: 0 };
      }
    };
    const first = stat(); // 刚选好位置时文件是空的（或者是要被覆盖的旧文件）
    const started = Date.now();
    let last = -1;
    let sawWriting = false;
    const stop = () => {
      clearInterval(watchedSaves.get(file));
      watchedSaves.delete(file);
    };
    watchedSaves.set(
      file,
      setInterval(() => {
        try {
          const writing = fs.existsSync(file + '.crswap');
          if (writing) sawWriting = true;
          const cur = stat();
          const changed = cur.size > 0 && (first.size === 0 || cur.mtime > first.mtime);
          if (changed && !writing && cur.size === last) {
            stop();
            const opened = openDoc(file);
            if (opened) toastTo(wc, T('已保存并打开：{0}', path.basename(file)), '', file);
            diag('fs-saved', { ext: fileExt(file), bytes: cur.size, opened }, 40, wc);
            return;
          }
          last = cur.size;
          // 一直没有动静（只是网页又查了一次权限）就不等了；真在写的大文件最多等 30 分钟
          const age = Date.now() - started;
          if ((!sawWriting && !changed && age > 20000) || age > 30 * 60 * 1000) {
            stop();
            diag('fs-idle', { ext: fileExt(file), bytes: cur.size, sawWriting }, 20, wc);
          }
        } catch (_) {
          stop();
        }
      }, 700)
    );
  }

  function hardenSession(ses) {
    if (ses.__trxHardened) return;
    ses.__trxHardened = true;
    ses.on('will-download', (event, item, wc) => onDownload(item, wc));
    // 我们自己的页面（file://，比如设置页录音克隆声音）和聊天网站允许白名单里的权限，其他来源一律拒绝
    const originOk = (u) => u.protocol === 'file:' || opts.allowedHosts.includes(u.host);
    // 文件系统接口（fileSystem）：WhatsApp 网页保存文档用的就是它——先弹系统的“另存为”，用户选好位置后网页往那个文件里写。
    // 当初加权限白名单时漏了这一项，结果是文件存下来是 0 字节、网页上一直转圈。
    // 只放行“单个文件”（用户在对话框里亲手选的那个）；整个文件夹的读写仍然拒绝。
    const fileOk = (permission, details) => permission === 'fileSystem' && !!details && details.isDirectory !== true;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      let ok = ALLOWED_PERMISSIONS.has(permission) || fileOk(permission, details);
      try {
        if (!originOk(new URL((details && details.requestingUrl) || (wc && wc.getURL()) || ''))) ok = false;
      } catch (_) {
        ok = false;
      }
      if (ok && permission === 'fileSystem') noteSavedFile(details, wc);
      if (!ok) diag('perm-denied:' + permission, { how: 'request', dir: !!(details && details.isDirectory) }, 1, wc);
      callback(ok);
    });
    ses.setPermissionCheckHandler((wc, permission, origin, details) => {
      try {
        const ok = (ALLOWED_PERMISSIONS.has(permission) || fileOk(permission, details)) && originOk(new URL(origin));
        if (ok && permission === 'fileSystem') noteSavedFile(details, wc);
        if (!ok) diag('perm-denied:' + permission, { how: 'check', dir: !!(details && details.isDirectory) }, 1, wc);
        return ok;
      } catch (_) {
        return false;
      }
    });
    // 浏览器内核把一些位置算作“敏感位置”（网络共享盘、AppData、系统目录……），往那里存文件要先问我们；
    // 没人回答的话网页会一直等下去（转圈）。用户在对话框里亲手选的单个文件 → 放行；整个文件夹 → 拒绝
    ses.on('file-system-access-restricted', (event, details, callback) => {
      let ok = false;
      try {
        ok = !!details && details.isDirectory !== true && originOk(new URL(details.origin));
      } catch (_) {}
      diag('fs-restricted', { ok, dir: !!(details && details.isDirectory) }, 20);
      try {
        callback(ok ? 'allow' : 'deny');
      } catch (_) {}
    });
  }

  function allowedNavigation(url) {
    try {
      const u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'about:') && (u.protocol === 'about:' || opts.allowedHosts.includes(u.host));
    } catch (_) {
      return false; // 解析不了的地址一律不放行
    }
  }

  async function createView(acc) {
    const ses = sessionFor(acc);
    hardenSession(ses);
    await applyProxy(acc);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: opts.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    const wc = view.webContents;
    const entry = { view, unread: 0, error: '' };
    views.set(acc.id, entry);
    wc.setUserAgent(opts.userAgent);
    // 开了代理时不让 WebRTC 走真实网卡，避免泄露本机 IP
    if (wc.setWebRTCIPHandlingPolicy) wc.setWebRTCIPHandlingPolicy(proxy.isProxyOn(acc.proxy) ? 'disable_non_proxied_udp' : 'default');
    wc.setWindowOpenHandler(({ url }) => {
      // 网页想在新窗口里打开自己生成的文件（比如 PDF）→ 当成下载：存下来，再用系统默认程序打开
      if (ownBlob(url)) {
        downloadBlobSoon(wc, url, 'window');
        return { action: 'deny' };
      }
      // 不是网页链接的（空白页、别的协议）不会交给系统浏览器，等于什么都没发生——记下来，方便以后查“点了没反应”
      if (!/^(https?:|mailto:|tel:)/i.test(String(url || ''))) diag('popup-dropped', { to: siteOf(url) }, 20, wc);
      opts.openExternal(url);
      return { action: 'deny' };
    });
    // 同一个网站、但不是我们支持的版本（比如在 Telegram 菜单里点了“切换到 A 版”）→ 留在原地
    const pathAllowed = (url) => {
      if (!opts.pathPrefix) return true;
      try {
        const u = new URL(url);
        return u.protocol === 'about:' || u.pathname === opts.pathPrefix || u.pathname.startsWith(opts.pathPrefix + '/');
      } catch (_) {
        return false;
      }
    };
    const guardNav = (e, url) => {
      if (ownBlob(url)) {
        // 整个页面跳到文件地址 = 想下载它。跳转要拦下（聊天页面不能被冲掉），改成下载
        e.preventDefault();
        downloadBlobSoon(wc, url, 'nav');
        return;
      }
      if (!allowedNavigation(url)) {
        e.preventDefault();
        if (!/^(https?:|mailto:|tel:)/i.test(String(url || ''))) diag('nav-dropped', { to: siteOf(url) }, 20, wc);
        opts.openExternal(url);
        return;
      }
      if (!pathAllowed(url)) e.preventDefault();
    };
    wc.on('will-navigate', guardNav);
    wc.on('will-redirect', guardNav);
    wc.on('will-frame-navigate', (e) => {
      // 子框架只允许同站（含本站自己生成的 blob: 文件——用隐藏框架下载文件是网页的常用办法）；别的一律拦掉（不弹到外部浏览器）
      if (!e.isMainFrame && !allowedNavigation(e.url) && !ownBlob(e.url)) {
        e.preventDefault();
        diag('frame-blocked:' + siteOf(e.url), {}, 1, wc);
      }
    });
    // 代理需要用户名密码时自动填。密码错时 Chromium 会反复触发 login，只自动尝试一次，之后标记代理异常
    let proxyAuthTries = 0;
    wc.on('login', (event, details, authInfo, callback) => {
      const a = accounts.find((x) => x.id === acc.id);
      if (!(authInfo && authInfo.isProxy && a && a.proxy && a.proxy.username)) return;
      event.preventDefault();
      if (proxyAuthTries++ < 1) {
        callback(a.proxy.username, a.proxy.password || '');
      } else {
        callback();
        entry.error = T('代理用户名或密码错误（407）');
        ipCache.set(acc.id, { error: entry.error, at: Date.now() });
        emit();
      }
    });
    wc.on('did-start-navigation', (e) => {
      if (e.isMainFrame) proxyAuthTries = 0;
    });
    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = ABORTED（正常的重复加载）
      entry.error = desc + ' (' + code + ')';
      emit();
    });
    wc.on('did-finish-load', () => {
      if (entry.error) {
        entry.error = '';
        emit();
      }
    });
    wc.on('render-process-gone', (e, details) => {
      entry.error = T('页面崩溃：{0}', details && details.reason);
      emit();
    });
    wc.on('page-title-updated', (e, title) => {
      const m = String(title || '').match(/\((\d+)\)/);
      const n = m ? parseInt(m[1], 10) : 0;
      if (n !== entry.unread) {
        entry.unread = n;
        emit();
      }
    });
    opts.win.contentView.addChildView(view);
    layout();
    wc.loadURL(opts.url, { userAgent: opts.userAgent });
    return entry;
  }

  function destroyView(id) {
    const v = views.get(id);
    if (!v) return;
    try {
      opts.win.contentView.removeChildView(v.view);
    } catch (_) {}
    try {
      v.view.webContents.close();
    } catch (_) {}
    views.delete(id);
  }

  // ---- 出口 IP 检测（走指定 session 的代理） ----
  function requestJSON(ses, url, auth, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = net.request({ url, session: ses, useSessionCookies: false });
      const timer = setTimeout(() => {
        try {
          req.abort();
        } catch (_) {}
        reject(new Error(T('连接超时（代理可能不可用）')));
      }, timeoutMs || 15000);
      req.on('login', (authInfo, callback) => {
        if (auth && auth.username) callback(auth.username, auth.password || '');
        else callback();
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString()));
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode === 407) return reject(new Error(T('代理用户名或密码错误（407）')));
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            reject(new Error(T('返回内容无法识别（HTTP {0}）', res.statusCode)));
          }
        });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        const m = String((err && err.message) || err);
        reject(new Error(/PROXY|TUNNEL|SOCKS/i.test(m) ? T('连不上代理：') + m : T('网络错误：') + m));
      });
      req.end();
    });
  }

  async function lookupIP(ses, auth) {
    try {
      const j = await requestJSON(ses, 'https://ipinfo.io/json', auth, 15000);
      return { ip: j.ip, place: [j.country, j.region, j.city].filter(Boolean).join(' · '), at: Date.now() };
    } catch (err) {
      // 备用查询
      try {
        const j = await requestJSON(ses, 'https://api.ipify.org?format=json', auth, 12000);
        return { ip: j.ip, place: '', at: Date.now() };
      } catch (_) {
        throw err;
      }
    }
  }

  /** 测试一个还没保存的代理配置 */
  // session 对象创建后无法销毁，所以固定用一个测试分区，每次换代理前把旧连接断掉
  let testing = Promise.resolve();
  function testProxy(p) {
    const bad = proxy.validateProxy(p);
    if (bad) return Promise.reject(new Error(bad));
    const run = async () => {
      const ses = session.fromPartition('trx-proxy-test');
      await ses.setProxy(proxy.proxyConfig(p));
      if (ses.closeAllConnections) await ses.closeAllConnections();
      try {
        return await lookupIP(ses, p);
      } finally {
        try {
          await ses.clearStorageData();
        } catch (_) {}
      }
    };
    const next = testing.then(run, run);
    testing = next.catch(() => {});
    return next;
  }

  /** 查某个账号当前的出口 IP */
  async function checkAccountIP(id) {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) throw new Error(T('账号不存在'));
    try {
      const r = await lookupIP(sessionFor(acc), acc.proxy);
      ipCache.set(id, r);
    } catch (err) {
      ipCache.set(id, { error: err.message, at: Date.now() });
    }
    emit();
    return ipCache.get(id);
  }

  // ---- 对外操作 ----
  async function init() {
    const data = opts.storage.load() || {};
    accounts = Array.isArray(data.accounts) ? data.accounts : [];
    groups = Array.isArray(data.groups) ? data.groups.filter((g) => g && g.name).map((g) => ({ name: cleanGroupName(g.name), collapsed: !!g.collapsed })) : [];
    accounts.forEach((a) => {
      a.group = cleanGroupName(a.group);
      ensureGroup(a.group);
    });
    if (!accounts.length) {
      // 第一次使用：沿用原来的登录数据（默认 session），不用重新扫码
      accounts = [{ id: newId(), name: T('账号 {0}', 1), color: COLORS[0], partition: '', proxy: { type: 'none' } }];
    }
    accounts.forEach((a) => cleanOverrides({ engine: a.engine, defaultTheirLang: a.defaultTheirLang, tone: a.tone }, a));
    activeId = accounts.some((a) => a.id === data.activeId) ? data.activeId : accounts[0].id;
    persist();
    opts.win.on('resize', layout);
    emit();
    // 一个账号失败不影响其他账号
    for (const acc of accounts) {
      try {
        await createView(acc);
      } catch (err) {
        console.error('[accounts] create view failed', acc.id, err);
        ipCache.set(acc.id, { error: T('账号加载失败：{0}', (err && err.message) || err), at: Date.now() });
      }
    }
    layout();
    emit();
    // 出口 IP 不再自动检测（会把代理信息发到第三方），在账号编辑框里手动点“检测 IP”
  }

  function switchTo(id) {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return false;
    activeId = id;
    // 切到折叠分组里的账号时自动展开
    const g = groups.find((x) => x.name === acc.group);
    if (g && g.collapsed) g.collapsed = false;
    persist();
    layout();
    const v = views.get(id);
    if (v) v.view.webContents.focus();
    emit();
    return true;
  }

  function switchToIndex(i) {
    const list = displayOrder();
    if (list[i]) switchTo(list[i].id);
  }

  async function add({ name, proxy: p, group, engine, defaultTheirLang, tone }) {
    const bad = proxy.validateProxy(p);
    if (bad) throw new Error(bad);
    const id = newId();
    const acc = {
      id,
      name: String(name || '').trim().slice(0, 40) || T('账号 {0}', accounts.length + 1),
      color: COLORS[accounts.length % COLORS.length],
      partition: 'persist:acc-' + id,
      proxy: normalizeProxy(p),
      group: cleanGroupName(group),
    };
    cleanOverrides({ engine, defaultTheirLang, tone }, acc);
    ensureGroup(acc.group);
    const g = groups.find((x) => x.name === acc.group);
    if (g) g.collapsed = false;
    accounts.push(acc);
    activeId = id;
    persist();
    try {
      await createView(acc);
    } catch (err) {
      ipCache.set(acc.id, { error: T('账号加载失败：{0}', (err && err.message) || err), at: Date.now() });
    }
    layout();
    emit();
    return publicAccount(acc);
  }

  function normalizeProxy(p, old) {
    if (!p || !p.type || p.type === 'none') return { type: 'none' };
    const out = {
      type: p.type,
      host: String(p.host || '').trim(),
      port: parseInt(p.port, 10),
      username: String(p.username || '').trim(),
      password: p.password !== undefined && p.password !== null && p.password !== '' ? String(p.password) : (old && old.password) || '',
    };
    if (!out.username) out.password = '';
    return out;
  }

  async function update(id, { name, proxy: p, group, engine, defaultTheirLang, tone }) {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) throw new Error(T('账号不存在'));
    if (name !== undefined) acc.name = String(name).trim().slice(0, 40) || acc.name;
    const beforeOv = JSON.stringify(overridesOf(acc));
    cleanOverrides({ engine, defaultTheirLang, tone }, acc);
    const ovChanged = JSON.stringify(overridesOf(acc)) !== beforeOv;
    if (group !== undefined) {
      acc.group = cleanGroupName(group);
      ensureGroup(acc.group);
    }
    if (p !== undefined) {
      const next = normalizeProxy(p, acc.proxy);
      const bad = proxy.validateProxy(next);
      if (bad) throw new Error(bad);
      const changed = JSON.stringify(next) !== JSON.stringify(acc.proxy || {});
      acc.proxy = next;
      if (changed) {
        await applyProxy(acc);
        const v = views.get(id);
        if (v) {
          const wc = v.view.webContents;
          if (wc.setWebRTCIPHandlingPolicy) wc.setWebRTCIPHandlingPolicy(proxy.isProxyOn(acc.proxy) ? 'disable_non_proxied_udp' : 'default');
          wc.reload();
        }
        ipCache.delete(id);
      }
    }
    persist();
    emit();
    if (ovChanged && opts.onAccountChanged) opts.onAccountChanged(acc);
    return publicAccount(acc);
  }

  async function remove(id) {
    if (accounts.length <= 1) throw new Error(T('至少要保留一个账号'));
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return false;
    destroyView(id);
    accounts = accounts.filter((a) => a.id !== id);
    ipCache.delete(id);
    // 删除这个账号的登录数据（第一个账号用的是默认数据，不删 cookie 以外的东西也没问题）
    try {
      await sessionFor(acc).clearStorageData();
    } catch (_) {}
    if (activeId === id) activeId = accounts[0].id;
    persist();
    layout();
    emit();
    return true;
  }

  // 在同一个分组里上移 / 下移
  function move(id, delta) {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return false;
    const same = accounts.filter((a) => (a.group || '') === (acc.group || ''));
    const k = same.indexOf(acc);
    const other = same[k + delta];
    if (!other) return false;
    const i = accounts.indexOf(acc);
    const j = accounts.indexOf(other);
    accounts[i] = other;
    accounts[j] = acc;
    persist();
    emit();
    return true;
  }

  function setGroupCollapsed(name, collapsed) {
    const g = groups.find((x) => x.name === name);
    if (!g) return false;
    g.collapsed = !!collapsed;
    persist();
    emit();
    return true;
  }

  function renameGroup(oldName, newName) {
    const nn = cleanGroupName(newName);
    if (!nn) throw new Error(T('分组名称不能为空'));
    const g = groups.find((x) => x.name === oldName);
    if (!g) throw new Error(T('分组不存在'));
    if (nn !== oldName && groups.some((x) => x.name === nn)) {
      // 改成已有的组名 = 合并到那个组
      accounts.forEach((a) => {
        if (a.group === oldName) a.group = nn;
      });
      groups = groups.filter((x) => x !== g);
    } else {
      g.name = nn;
      accounts.forEach((a) => {
        if (a.group === oldName) a.group = nn;
      });
    }
    persist();
    emit();
    return true;
  }

  function moveGroup(name, delta) {
    const i = groups.findIndex((x) => x.name === name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= groups.length) return false;
    const [g] = groups.splice(i, 1);
    groups.splice(j, 0, g);
    persist();
    emit();
    return true;
  }

  // 删除分组：组里的账号变成“未分组”，不会删除账号
  function removeGroup(name) {
    if (!groups.some((x) => x.name === name)) return false;
    groups = groups.filter((x) => x.name !== name);
    accounts.forEach((a) => {
      if (a.group === name) a.group = '';
    });
    persist();
    emit();
    return true;
  }

  function addGroup(name) {
    const nn = cleanGroupName(name);
    if (!nn) throw new Error(T('分组名称不能为空'));
    ensureGroup(nn);
    persist();
    emit();
    return true;
  }

  function reload(id) {
    const v = views.get(id || activeId);
    if (v) v.view.webContents.reload();
  }

  function setOverlay(on) {
    overlay = !!on;
    layout();
  }

  return {
    init,
    state,
    switchTo,
    switchToIndex,
    add,
    update,
    remove,
    move,
    setGroupCollapsed,
    renameGroup,
    moveGroup,
    removeGroup,
    addGroup,
    reload,
    setOverlay,
    testProxy,
    checkAccountIP,
    layout,
    fileAction,
    isPageSender: (e) => {
      for (const v of views.values()) if (v.view.webContents === e.sender) return true;
      return false;
    },
    allWebContents: () => Array.from(views.values()).map((v) => v.view.webContents),
    webContentsFor: (id) => {
      const v = views.get(id);
      return v ? v.view.webContents : null;
    },
    // 某个页面（webContents 或 IPC 事件）对应账号的覆盖项
    overridesFor: (wcOrEvent) => {
      const wc = wcOrEvent && wcOrEvent.sender ? wcOrEvent.sender : wcOrEvent;
      for (const [id, v] of views) if (v.view.webContents === wc) return overridesOf(accounts.find((a) => a.id === id));
      return null;
    },
    activeWebContents: () => {
      const v = views.get(activeId);
      return v ? v.view.webContents : null;
    },
    accountForSender: (e) => {
      for (const [id, v] of views) if (v.view.webContents === e.sender) return accounts.find((a) => a.id === id) || null;
      return null;
    },
  };
}

module.exports = { createAccountManager, SIDEBAR_WIDTH };
