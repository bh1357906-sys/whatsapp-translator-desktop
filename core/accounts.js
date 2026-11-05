// 多账号：每个账号一个独立的登录数据（session 分区）和独立的代理；窗口左侧是账号栏（shell.html）
'use strict';

const { WebContentsView, session, net } = require('electron');
const proxy = require('./proxy');
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
 *   storage: { load() → {accounts, activeId}, save(data) },  // 已解密 / 由宿主加密
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

  function hardenSession(ses) {
    if (ses.__trxHardened) return;
    ses.__trxHardened = true;
    // 我们自己的页面（file://，比如设置页录音克隆声音）和聊天网站允许白名单里的权限，其他来源一律拒绝
    const originOk = (u) => u.protocol === 'file:' || opts.allowedHosts.includes(u.host);
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      let ok = ALLOWED_PERMISSIONS.has(permission);
      try {
        if (!originOk(new URL((details && details.requestingUrl) || (wc && wc.getURL()) || ''))) ok = false;
      } catch (_) {
        ok = false;
      }
      callback(ok);
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => {
      try {
        return ALLOWED_PERMISSIONS.has(permission) && originOk(new URL(origin));
      } catch (_) {
        return false;
      }
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
      opts.openExternal(url);
      return { action: 'deny' };
    });
    const guardNav = (e, url) => {
      if (allowedNavigation(url)) return;
      e.preventDefault();
      opts.openExternal(url);
    };
    wc.on('will-navigate', guardNav);
    wc.on('will-redirect', guardNav);
    wc.on('will-frame-navigate', (e) => {
      // 子框架只允许同站；别的一律拦掉（不弹到外部浏览器）
      if (!e.isMainFrame && !allowedNavigation(e.url)) e.preventDefault();
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
