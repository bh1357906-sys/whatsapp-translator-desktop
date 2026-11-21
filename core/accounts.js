// 多账号：每个账号一个独立的登录数据（session 分区）和独立的代理；窗口左侧是账号栏（shell.html）
'use strict';

const { WebContentsView, session, net, app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const proxy = require('./proxy');
const { AUTO_OPEN_EXT, DANGER_EXT, fileExt, cleanFileName, uniquePath, releasePath } = require('./files');
const { siteOf, cleanConsole } = require('./safe-log');
const health = require('./health');
const { T } = require('./i18n');

const lang = require('./lang');

const SIDEBAR_WIDTH = 68;
// 内核自带的 PDF 查看器（和 Chrome 里的是同一个，编号固定）
const PDF_VIEWER = /^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai\//i;
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
 *   thirdPartyFrames,   // 可选：允许聊天页面里嵌第三方 https 网页（WhatsApp 的内置 PDF 查看器需要）；不设就只允许本站
 *   strictSocket,   // 可选：这个网站只靠一条长连接收消息（WhatsApp）——长连接连不上就按“收不到消息”报警；不设则只给黄色提醒
 *   onAlert(list),   // 可选：有账号出了“收不到消息”的问题并且持续了一阵子 → [{ id, name, text, code }]
 *   openExternal(url), onChange(state), onAccountChanged(acc)
 * }
 */
function createAccountManager(opts) {
  let accounts = [];
  let groups = []; // [{ name, collapsed }]，按显示顺序；账号的 group 为空 = 未分组
  let activeId = null;
  let overlay = false; // 账号栏弹出编辑框时，临时隐藏网页
  const views = new Map(); // id → { view, unread, error, h }（h = 这个账号的“连接状况”，见 newHealth）
  const ipCache = new Map(); // id → { ip, place, at, error }
  const TIMES = health.TIMES;
  let closing = false; // 软件正在退出：这时页面进程被关掉是正常的，不要当成崩溃去重开
  let knownSocket = false; // 见过这个网站的长连接握手成功——说明它确实是靠长连接收消息的（“加载完却一直没连接”的判断要用）
  let tickTimer = null;
  let tickAt = 0;
  let pingSeq = 0;

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
      // 这个账号现在有没有“收不到消息”一类的问题：null = 正常；{ level: 'err' | 'warn', code, text }
      status: v ? statusOf(v, Date.now()) : null,
    };
  }

  // ---- 连接状况：断了能自己恢复，恢复不了要让人看得见 ----
  // 账号大多数时候隐藏在后台，页面悄悄断线（代理抽风、网页没加载出来、页面进程崩溃、卡死）没人看得见，
  // 表现就是“这个账号收不到消息”。每个账号记一份状况，出了问题：自动恢复 + 账号栏上标出来 + 记日志 + 持续一阵子就弹通知
  function newHealth() {
    return {
      loadOk: false, // 主页面这一次是不是正常加载出来的
      loadedAt: 0,
      loadFails: 0, // 连续加载失败了几次
      failText: '', // 没加载出来的原因（给人看的）
      retryTimer: null,
      crashed: false,
      crashes: [], // 最近几次崩溃的时间
      crashTimer: null,
      auth: health.createAuthGate(), // 代理要用户名密码时怎么答
      authBad: false, // 代理不认用户名密码
      authNone: false, // ……原因是这个账号根本没填
      authRefusedAt: 0,
      sockets: new Map(), // 长连接：主机 → 最近一次握手成没成
      wsOkAt: 0,
      wsFailSince: 0,
      wsFails: 0,
      keeping: false, // 正在经代理探测（见 keepProxy）
      keptAt: 0,
      proxyDownSince: 0, // 代理从什么时候开始连不上的
      proxyFails: 0,
      proxyAnswers: false, // 见过这个代理正常地回话（见 keepProxy）
      pongAt: 0, // 页面上一次应答“还在吗”的时间
      pongSeen: false,
      hung: false,
      hungAt: 0,
      stuck: false, // 加载完了却一直没连聊天服务器，自动重新加载也没用
      stuckReloads: [],
      page: '', // 页面自己报的：'chat' 已登录 / 'login' 停在登录界面 / '' 说不准
      pageSince: 0,
      code: '', // 当前的问题（'' = 没问题）
      since: 0, // 问题从什么时候开始的
      alertAt: 0,
    };
  }

  function statusOf(v, now) {
    const h = v && v.h;
    if (!h) return null;
    if (h.crashed) return { level: 'err', code: 'crash', text: T('页面进程崩溃了，软件正在自动重新打开它') };
    if (h.hung) return { level: 'err', code: 'hung', text: T('页面卡死了，软件正在自动重新打开它') };
    if (h.authBad && h.authNone) return { level: 'err', code: 'proxy-auth', text: T('代理要用户名和密码，但这个账号没有填，现在收不到消息。请编辑这个账号，把代理的用户名和密码填上') };
    if (h.authBad) return { level: 'err', code: 'proxy-auth', text: T('代理不接受用户名或密码（407），这个账号现在收不到消息。软件会自动再试；一直这样多半是代理到期了或密码改了') };
    if (h.failText) return { level: 'err', code: 'load', text: T('页面没加载出来（{0}），这个账号现在收不到消息。软件正在自动重试', h.failText) };
    if (h.proxyDownSince && h.proxyFails >= 2 && now - h.proxyDownSince >= TIMES.offlineAfter)
      return { level: 'err', code: 'proxy-down', text: T('连不上代理（或者电脑断网了），这个账号现在收不到消息。恢复后会自动连上') };
    if (h.stuck) return { level: 'err', code: 'stuck', text: T('页面加载完了，但一直没连上聊天服务器，这个账号可能收不到消息。请点“重新加载页面”') };
    if (h.wsFailSince && h.wsFails >= 3 && now - h.wsFailSince >= TIMES.offlineAfter && !Array.from(h.sockets.values()).some(Boolean))
      return { level: opts.strictSocket ? 'err' : 'warn', code: 'offline', text: T('连不上聊天服务器，这个账号可能收不到消息（多半是网络或代理的问题）。网络恢复后会自动连上') };
    if (h.page === 'login' && h.pageSince && now - h.pageSince >= TIMES.loginAfter) return { level: 'warn', code: 'login', text: T('这个账号没有登录（页面停在登录 / 扫码界面）') };
    return null;
  }

  // 连接日志（translator.log，kind: 'conn'）：只记“什么时候、哪个账号、发生了什么、错误码”，不记网址和聊天内容。
  // 每个账号每小时限量，免得网络一直不通时把日志刷满
  const logBudget = health.createLogBudget(80, 3600 * 1000);
  function connLog(acc, ev, data) {
    try {
      if (!opts.log) return;
      const now = Date.now();
      const key = acc ? acc.id : '';
      const name = acc ? acc.name : '';
      const missed = logBudget.dropped(key, now);
      if (missed) opts.log({ acc: name, kind: 'conn', ev: 'log-skipped', n: missed });
      if (!logBudget.take(key, now)) return;
      opts.log({ acc: name, kind: 'conn', ev, ...(data || {}) });
    } catch (_) {}
  }

  // 状况变了（出问题 / 换了一种问题 / 恢复了）：记一笔，并通知账号栏
  function refresh(acc, entry) {
    const now = Date.now();
    const h = entry.h;
    const st = statusOf(entry, now);
    const code = st ? st.code : '';
    if (code === h.code) return;
    if (code) {
      if (!h.code) h.since = now;
      connLog(acc, 'problem', { what: code, level: st.level });
    } else {
      connLog(acc, 'recovered', { what: h.code, sec: Math.round((now - h.since) / 1000) });
      h.since = 0; // alertAt 不清：时好时坏的账号，通知也是最多半小时一次
    }
    h.code = code;
    emit();
  }

  // 长连接握手的结果（见 watchSockets）
  function noteSocket(accId, host, ok, why) {
    const entry = views.get(accId);
    const acc = accounts.find((a) => a.id === accId);
    if (!entry || !acc) return;
    const h = entry.h;
    const now = Date.now();
    const before = h.sockets.get(host);
    h.sockets.set(host, ok);
    if (ok) {
      knownSocket = true;
      if (h.wsFailSince) connLog(acc, 'socket-back', { downSec: Math.round((now - h.wsFailSince) / 1000), fails: h.wsFails });
      else if (before === true) connLog(acc, 'socket-reconnect', { upSec: Math.round((now - h.wsOkAt) / 1000) }); // 连得好好的又连了一次 = 中间断过
      else if (!h.wsOkAt) connLog(acc, 'socket-up', { sec: h.loadedAt ? Math.round((now - h.loadedAt) / 1000) : 0 });
      h.wsOkAt = now;
      h.wsFailSince = 0;
      h.wsFails = 0;
      h.stuck = false;
      h.proxyDownSince = 0;
      h.proxyFails = 0;
      // 请求经过代理成功了：用户名密码没问题
      h.auth.ok();
      h.authBad = false;
      h.authNone = false;
    } else {
      h.wsFails++;
      if (!h.wsFailSince) {
        h.wsFailSince = now;
        connLog(acc, 'socket-fail', { why: String(why || '').slice(0, 60) });
      } else if (h.wsFails % 25 === 0) connLog(acc, 'socket-fail', { why: String(why || '').slice(0, 60), n: h.wsFails, sec: Math.round((now - h.wsFailSince) / 1000) });
    }
    refresh(acc, entry);
  }

  // 盯着这个账号的长连接（WebSocket）握手：成了 / 没成。握手之后的事（收发了什么）看不到，也不需要看。
  //
  // 这一步还有一个必不可少的作用：只有装了这组监听，内核才会在“长连接握手时代理要用户名密码”的时候来问我们（login 事件）。
  // 不装的话内核直接放弃——于是代理只要有一次不认缓存的密码，这个账号的长连接就再也连不上，直到重新加载页面。
  // 实测（Electron 44）：不装监听，重连时一次都不会来问；装了，每次都会问。所以这里不能省
  function watchSockets(ses, accId) {
    if (ses.__trxSock) {
      ses.__trxSock.id = accId;
      return;
    }
    const ref = (ses.__trxSock = { id: accId });
    const filter = { urls: ['wss://*/*'] };
    try {
      ses.webRequest.onCompleted(filter, (d) => {
        try {
          const host = health.siteHost(d.url, opts.allowedHosts);
          if (host) noteSocket(ref.id, host, d.statusCode === 101, 'HTTP ' + d.statusCode);
        } catch (_) {}
      });
      ses.webRequest.onErrorOccurred(filter, (d) => {
        try {
          const host = health.siteHost(d.url, opts.allowedHosts);
          if (host && d.error !== 'net::ERR_ABORTED') noteSocket(ref.id, host, false, d.error);
        } catch (_) {}
      });
    } catch (err) {
      console.error('[accounts] webRequest unavailable', err);
    }
  }

  // 代理要用户名密码：这个账号现在答不答（见 health.createAuthGate）。
  // 返回 { username, password } = 答；null = 这次不答；undefined = 这个账号没填用户名密码，不归我们管
  function proxyAnswer(acc, entry, first) {
    const a = accounts.find((x) => x.id === acc.id);
    if (!(a && a.proxy && a.proxy.username)) return undefined; // 这个账号没填用户名密码：不归我们管
    const h = entry.h;
    const verdict = h.auth.ask(Date.now(), first);
    if (verdict === 'answer') {
      if (first === false) connLog(a, 'proxy-reauth', {}); // 代理没认之前的验证，又来要了一次（代理抽风时会这样）
      return { username: a.proxy.username, password: a.proxy.password || '' };
    }
    h.authRefusedAt = Date.now();
    if (verdict === 'locked') {
      connLog(a, 'proxy-auth-rejected', { strikes: h.auth.state().strikes });
      // 把内核记住的用户名密码清掉：不清的话，内核会在每次重连时自己先拿记住的那份去试（不经过我们），
      // 等于一秒一次地拿被拒的密码去撞代理（实测：代理换过验证域名后就会这样）
      try {
        const ses = sessionFor(a);
        if (ses.clearAuthCache) Promise.resolve(ses.clearAuthCache()).catch(() => {});
      } catch (_) {}
    }
    if (!h.authBad || h.authNone) {
      h.authBad = true;
      h.authNone = false;
      refresh(a, entry);
      emit();
    }
    return null;
  }

  // 不属于任何页面的请求（比如网站的 service worker、共享后台线程发的）遇到代理要用户名密码：
  // 内核不告诉我们是哪个账号的，只能按“代理地址 + 端口”去对；对得上、而且用这个代理的账号填的用户名密码都一样，才答。
  // 只管发往聊天网站自己的请求——内核自己在后台发的别的请求（比如下载拼写词典）不替它过代理
  function proxyAuthFor(authInfo, first, url) {
    if (!(authInfo && authInfo.isProxy)) return null;
    if (!health.siteHost(url, opts.allowedHosts)) return null;
    const mine = accounts.filter((a) => a.proxy && a.proxy.username && String(a.proxy.host).toLowerCase() === String(authInfo.host || '').toLowerCase() && Number(a.proxy.port) === Number(authInfo.port));
    if (!mine.length) return null;
    if (mine.some((a) => a.proxy.username !== mine[0].proxy.username || (a.proxy.password || '') !== (mine[0].proxy.password || ''))) return null;
    const entry = views.get(mine[0].id);
    if (!entry) return null;
    return proxyAnswer(mine[0], entry, first) || null;
  }

  // ---- 经代理探一下：让内核“记住的代理密码”保持有效，顺带知道代理通不通 ----
  // 给谁用：走代理、而且我们看不到它长连接的账号。有的网站（Telegram）把网络通讯放在“共享后台线程”里，那里的长连接：
  //   · 握手成没成我们看不到（watchSockets 只看得到页面和普通后台线程里的）；
  //   · 握手时代理要用户名密码，内核也不会来问我们，直接放弃。
  // 于是代理只要有一次不认缓存的密码，内核就把记住的密码丢掉，这个账号从此连不上——而且没有任何迹象。
  // 办法：每分钟经这个账号的代理发一个探测请求（目标是一个不存在的域名，.invalid 是专门保留的“永远解析不到”的后缀，
  // 所以这个请求到代理为止，不会连到任何网站）。代理如果又要密码，这个请求上内核会来问我们——答了，内核就重新记住，
  // 网站自己下一次重连就能过。探测的结果还能告诉我们代理是不是整个连不上了
  const KEEP_URL = 'https://keepalive.invalid/';
  function keepProxy(acc, entry) {
    const h = entry.h;
    if (h.keeping) return;
    let req = null;
    try {
      req = net.request({ url: KEEP_URL, method: 'HEAD', session: sessionFor(acc), useSessionCookies: false, credentials: 'omit' });
    } catch (_) {
      return;
    }
    h.keeping = true;
    let done = false;
    let asked = false;
    let refused = false;
    let timer = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      h.keeping = false;
      clearTimeout(timer);
      if (views.get(acc.id) !== entry) return;
      const now = Date.now();
      const e = String(err || '');
      // 实测各种状况下内核报的错（Electron 44）：
      //   代理正常（它当然连不到那个不存在的域名，回 502 / 503）→ TUNNEL_CONNECTION_FAILED
      //   代理的端口不通 / 域名解析不到 → PROXY_CONNECTION_FAILED
      //   代理一连上就断开（比如按 IP 白名单放行、而本机 IP 变了）→ SOCKET_NOT_CONNECTED / CONNECTION_RESET / EMPTY_RESPONSE（看时机）
      //   代理不回应 → 超时
      const alive = !e || /ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED/.test(e);
      // “连上就断 / 不回应”有两种可能：代理坏了，或者这家代理对连不到的域名就是这么处理的。
      // 所以只有见过这个代理“正常地回过话”，之后的断开 / 超时才算它出了问题
      const down =
        /ERR_PROXY_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_ACCESS_DENIED/.test(e) ||
        (h.proxyAnswers && /timeout|ERR_SOCKET_NOT_CONNECTED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/.test(e));
      if (alive) {
        h.proxyAnswers = true;
        if (h.proxyDownSince) connLog(acc, 'proxy-back', { downSec: Math.round((now - h.proxyDownSince) / 1000) });
        h.proxyDownSince = 0;
        h.proxyFails = 0;
        if (!refused) {
          // 而且没有（再）拒绝用户名密码
          if (asked) connLog(acc, 'proxy-refreshed', {});
          h.auth.ok();
          h.authBad = false;
          h.authNone = false;
        }
      } else if (down) {
        h.proxyFails++;
        if (!h.proxyDownSince) {
          h.proxyDownSince = now;
          connLog(acc, 'proxy-unreachable', { why: e.replace(/^net::/, '').slice(0, 40) });
        }
      }
      // 其它情况说明不了代理的状况：不动
      refresh(acc, entry);
    };
    timer = setTimeout(() => {
      try {
        req.abort();
      } catch (_) {}
      finish('timeout');
    }, 20000);
    req.on('login', (authInfo, callback) => {
      asked = true;
      const r = authInfo && authInfo.isProxy ? proxyAnswer(acc, entry, undefined) : null;
      if (r) return callback(r.username, r.password);
      // 不答：中止这个请求（不要不带参数调用 callback，见 requestJSON 里的说明）。代理既然来要密码了，说明它是通的
      refused = true;
      try {
        req.abort();
      } catch (_) {}
      finish('');
    });
    req.on('response', (res) => {
      if (res.statusCode === 407) refused = true;
      res.on('data', () => {});
      res.on('end', () => finish(''));
      res.on('error', () => finish(''));
    });
    req.on('error', (err) => finish(String((err && err.message) || err || 'error')));
    req.end();
  }

  // 定时巡查：问每个页面一声“还在吗”，顺带处理那些要“等一阵子才算数”的状况
  function tick() {
    const now = Date.now();
    // 主进程自己停过（电脑睡眠、严重卡顿）：这一轮不算“页面不应答”
    const stalled = tickAt && now - tickAt > TIMES.tick * 3;
    tickAt = now;
    const alerts = [];
    for (const acc of accounts) {
      const entry = views.get(acc.id);
      if (!entry) continue;
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      const h = entry.h;
      if (stalled) h.pongAt = now;
      try {
        wc.send('tr:ping', ++pingSeq);
      } catch (_) {}
      const settled = h.loadOk && !h.crashed && !h.failText && !wc.isLoading();
      // 卡死：答过话的页面，后来很久不答了。卡死的页面进程不会理会“重新加载”，只能先结束它——之后走“崩溃了自动重开”那条路
      if (h.hung && now - h.hungAt > 60 * 1000) {
        // 结束 + 重新加载都没让它换成新页面：过一分钟重新开始计时，再来一轮
        h.hung = false;
        h.pongAt = now;
      }
      if (settled && h.pongSeen && !h.hung && now - h.pongAt > TIMES.hungAfter) {
        h.hung = true;
        h.hungAt = now;
        connLog(acc, 'hung', { sec: Math.round((now - h.pongAt) / 1000) });
        try {
          wc.forcefullyCrashRenderer();
        } catch (_) {}
        setTimeout(() => {
          // 保险：万一进程没被结束（也就不会触发“崩溃后重开”），直接重新加载
          if (h.hung && !h.crashed && views.get(acc.id) === entry && !wc.isDestroyed()) {
            try {
              wc.reload();
            } catch (_) {}
          }
        }, 5000);
      }
      // 加载完了，却一直没去连聊天服务器（比如网页的脚本没下全）：重新加载；一小时内试过两次还这样，就标出来让人处理。
      // 只在“这个网站的长连接我们看得见”（knownSocket）时才这样判断；页面明确停在登录界面的不算（那是“没登录”，另有提醒）
      if (settled && knownSocket && !h.stuck && !h.wsOkAt && !h.wsFailSince && h.page !== 'login' && h.loadedAt && now - h.loadedAt > TIMES.stuckAfter) {
        h.stuckReloads = h.stuckReloads.filter((t) => now - t < 3600 * 1000);
        if (h.stuckReloads.length < 2) {
          h.stuckReloads.push(now);
          connLog(acc, 'stuck-reload', { n: h.stuckReloads.length });
          h.loadedAt = now;
          try {
            wc.reload();
          } catch (_) {}
        } else {
          h.stuck = true;
          connLog(acc, 'stuck', {});
        }
      }
      // 走代理、加载好了、但看不到它的长连接：定时经代理探一下（见 keepProxy）
      if (proxy.isProxyOn(acc.proxy) && settled && !h.wsOkAt && !h.wsFailSince && now - h.loadedAt >= TIMES.keepEvery / 2 && now - h.keptAt >= TIMES.keepEvery) {
        h.keptAt = now;
        keepProxy(acc, entry);
      }
      // 很久没再被代理拒绝了：不再显示“代理不认密码”
      if (h.authBad && now >= h.auth.state().lockUntil && now - h.authRefusedAt > TIMES.authForget) {
        h.authBad = false;
        h.authNone = false;
      }
      refresh(acc, entry);
      const st = statusOf(entry, now);
      if (st && st.level === 'err' && h.since && now - h.since >= TIMES.alertAfter && (!h.alertAt || now - h.alertAt >= TIMES.alertAgain)) {
        h.alertAt = now;
        alerts.push({ id: acc.id, name: acc.name, text: st.text, code: st.code });
      }
    }
    if (alerts.length && opts.onAlert) {
      try {
        opts.onAlert(alerts);
      } catch (_) {}
    }
  }

  // 页面应答了“还在吗”（顺带报了它现在停在哪个界面）
  function notePong(wc, st) {
    for (const [id, entry] of views) {
      if (entry.view.webContents !== wc) continue;
      const acc = accounts.find((a) => a.id === id);
      if (!acc) return;
      const h = entry.h;
      const now = Date.now();
      h.pongAt = now;
      h.pongSeen = true;
      const page = st && (st.page === 'chat' || st.page === 'login') ? st.page : '';
      if (page !== h.page) {
        h.page = page;
        h.pageSince = now;
      }
      refresh(acc, entry);
      return;
    }
  }

  // 电脑从睡眠中醒来：网络多半刚断过。等着重试的页面马上再试一次；“页面不应答”的计时重新开始
  function wake() {
    const now = Date.now();
    tickAt = now;
    for (const acc of accounts) {
      const entry = views.get(acc.id);
      if (!entry) continue;
      entry.h.pongAt = now;
      if (entry.h.retryTimer && entry.retryNow) entry.retryNow(5000);
    }
  }

  function shutdown() {
    closing = true;
    clearInterval(tickTimer);
    tickTimer = null;
    for (const entry of views.values()) {
      clearTimeout(entry.h.retryTimer);
      clearTimeout(entry.h.crashTimer);
    }
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

  // 聊天网站自己的地址（https，或它自己生成的 blob:）
  function ownSite(url) {
    try {
      if (ownBlob(url)) return true;
      const u = new URL(String(url || ''));
      return u.protocol === 'https:' && opts.allowedHosts.includes(u.host);
    } catch (_) {
      return false;
    }
  }
  // 聊天页面里嵌的第三方网页（子框架）。WhatsApp 的内置 PDF 查看器（和 Adobe 合作，2026 年 7 月上线）就是这样嵌进来的：
  // 以前子框架只允许本站，查看器加载不出来，页面上一直转圈。应用配置里打开 thirdPartyFrames 后，和 Chrome 一样放行 https 的网页。
  // 放行的只是“显示”——第三方框架拿不到麦克风 / 摄像头 / 通知等权限，它发起的下载也不会自动打开（见下面）
  function thirdPartyFrameOk(url) {
    if (!opts.thirdPartyFrames) return false;
    try {
      const str = String(url || '');
      if (/^blob:/i.test(str)) return new URL(str.slice(5)).protocol === 'https:';
      const p = new URL(str).protocol;
      return p === 'https:' || p === 'data:';
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
    // 只有聊天网站自己发起的下载才自动打开；页面里嵌的第三方框架发起的，只保存、给按钮
    const own = ownSite(item.getURL());
    item.once('done', (e, state) => {
      releasePath(file);
      let opened = false;
      if (state === 'completed') {
        if (own && AUTO_OPEN_EXT.has(fileExt(file)) && (opened = openDoc(file))) toastTo(wc, T('已下载并打开：{0}（保存在“下载”文件夹）', name), '', file);
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
    // 拼写检查用不上（聊天页面本来就关着）。不在这里整个关掉的话，内核会为每个账号去谷歌的服务器下载一份拼写词典——
    // 还是经过这个账号的代理去下的。软件不该多连一个用不着的地方
    try {
      if (ses.setSpellCheckerEnabled) ses.setSpellCheckerEnabled(false);
    } catch (_) {}
    ses.on('will-download', (event, item, wc) => onDownload(item, wc));
    // 我们自己的页面（file://，比如设置页录音克隆声音）和聊天网站允许白名单里的权限，其他来源一律拒绝
    const originOk = (u) => u.protocol === 'file:' || opts.allowedHosts.includes(u.host);
    // 文件系统接口（fileSystem）：WhatsApp 网页保存文档用的就是它——先弹系统的“另存为”，用户选好位置后网页往那个文件里写。
    // 当初加权限白名单时漏了这一项，结果是文件存下来是 0 字节、网页上一直转圈。
    // 只放行“单个文件”（用户在对话框里亲手选的那个）；整个文件夹的读写仍然拒绝。
    const fileOk = (permission, details) => permission === 'fileSystem' && !!details && details.isDirectory !== true;
    // 聊天页面里嵌的第三方框架（比如 PDF 查看器）只给这几项不敏感的：复制文字、全屏、往用户亲手选的文件里存。
    // 麦克风、摄像头、通知、读剪贴板、屏幕共享等一律不给——哪怕聊天网页把这些权限“转交”给了它
    const FRAME_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
    const topIsChat = (wc, details) => {
      try {
        const u = new URL((details && details.embeddingOrigin) || (wc && !wc.isDestroyed() ? wc.getURL() : ''));
        return u.protocol === 'https:' && opts.allowedHosts.includes(u.host);
      } catch (_) {
        return false;
      }
    };
    // 给不给：'own' = 聊天网站自己 / 我们自己的页面；'frame' = 聊天页面里的第三方框架；'' = 不给
    function grant(wc, permission, requester, details) {
      let own = false;
      try {
        own = originOk(new URL(requester));
      } catch (_) {}
      if (own) return ALLOWED_PERMISSIONS.has(permission) || fileOk(permission, details) ? 'own' : '';
      if (opts.thirdPartyFrames && details && details.isMainFrame === false && topIsChat(wc, details)) return FRAME_PERMISSIONS.has(permission) || fileOk(permission, details) ? 'frame' : '';
      return '';
    }
    const noteGrant = (how, g, wc, permission, requester, details) => {
      if (g === 'own' && permission === 'fileSystem') noteSavedFile(details, wc);
      if (!g) diag('perm-denied:' + permission, { how, dir: !!(details && details.isDirectory), frame: !!(details && details.isMainFrame === false), site: siteOf(requester) }, 2, wc);
      else if (g === 'frame') diag('perm-frame:' + permission, { how, site: siteOf(requester) }, 1, wc);
    };
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      let g = '';
      try {
        const requester = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
        g = grant(wc, permission, requester, details);
        noteGrant('request', g, wc, permission, requester, details);
      } catch (_) {
        g = '';
      }
      callback(!!g);
    });
    ses.setPermissionCheckHandler((wc, permission, origin, details) => {
      try {
        const g = grant(wc, permission, origin, details);
        noteGrant('check', g, wc, permission, origin, details);
        return !!g;
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
    const entry = { view, unread: 0, error: '', h: newHealth() };
    views.set(acc.id, entry);
    watchSockets(ses, acc.id);
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
      else diag('popup-external:' + siteOf(url), {}, 1, wc); // 网页想开新窗口 → 交给系统浏览器（每个网站只记一次）
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
      if (e.isMainFrame) return;
      // 子框架：本站（含本站自己生成的 blob: 文件——用隐藏框架下载文件是网页的常用办法）直接放行
      if (allowedNavigation(e.url) || ownBlob(e.url)) return;
      // 浏览器内核自带的 PDF 查看器：网页把 PDF 嵌在页面里显示时，内核会在那个小框架里再开一层自己的查看器页面
      if (PDF_VIEWER.test(String(e.url || ''))) return;
      // 第三方 https 网页：应用允许时放行（WhatsApp 的内置 PDF 查看器），否则拦掉（不弹到外部浏览器）
      if (thirdPartyFrameOk(e.url)) {
        diag('frame-ok:' + siteOf(e.url), {}, 1, wc);
        return;
      }
      e.preventDefault();
      diag('frame-blocked:' + siteOf(e.url), {}, 1, wc);
    });
    // 诊断：子框架加载失败、内核打印的“被拦下 / 被拒绝”一类的话
    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame && code !== -3) diag('frame-fail:' + siteOf(url), { code, desc: String(desc || '').slice(0, 60) }, 2, wc);
    });
    wc.on('console-message', (e, lvl, text) => {
      // 新版 Electron 把内容放在事件对象上（level 是 'error' 这样的字），老版本是后面几个参数（level 是数字，3 = error）
      const level = e && typeof e.level === 'string' ? e.level : lvl >= 3 ? 'error' : '';
      if (level !== 'error') return;
      const msg = cleanConsole(e && typeof e.message === 'string' ? e.message : text);
      if (msg) diag('console:' + msg.slice(0, 90), { msg }, 1, wc);
    });
    const h = entry.h;
    const alive = () => !closing && views.get(acc.id) === entry && !wc.isDestroyed();
    // 代理需要用户名密码时自动填。
    // 以前是“每个页面只填一次”：代理只要有一次不认账（抽风、换线路），之后再问就一律不答，这个账号就一直连不上、收不到消息，
    // 直到有人重新加载页面。现在每次问都答；只有连着被拒（密码真的不对 / 代理到期）才歇一会儿再试
    wc.on('login', (event, details, authInfo, callback) => {
      if (!(authInfo && authInfo.isProxy)) return;
      const r = proxyAnswer(acc, entry, details ? details.firstAuthAttempt : undefined);
      if (r === undefined) {
        // 代理要用户名密码，而这个账号没填：交回给内核（等于放弃），并在账号栏上说明白
        h.authRefusedAt = Date.now();
        if (!h.authBad || !h.authNone) {
          h.authBad = true;
          h.authNone = true;
          connLog(acc, 'proxy-auth-missing', {});
          refresh(acc, entry);
          emit();
        }
        return;
      }
      event.preventDefault();
      if (r) callback(r.username, r.password);
      else callback();
    });

    // ---- 页面没加载出来：自动重试，一直试到成功 ----
    // 以前失败一次就停在一片空白上（连错误提示都被紧接着的“错误页加载完成”清掉了），这个账号从此收不到消息，直到有人发现并手动刷新。
    // 最常见的时机：开机 / 软件更新后自动重启时网络或代理还没准备好
    const scheduleRetry = (ms) => {
      clearTimeout(h.retryTimer);
      h.retryTimer = setTimeout(() => {
        h.retryTimer = null;
        if (!alive() || h.loadOk || wc.isLoading()) return; // 已经好了，或者正在加载（比如有人手动刷新了）：看那一次的结果
        connLog(acc, 'load-retry', { n: h.loadFails });
        Promise.resolve(wc.loadURL(opts.url, { userAgent: opts.userAgent })).catch(() => {});
      }, ms);
    };
    entry.retryNow = scheduleRetry;
    const loadFailed = (text, kind, data) => {
      h.loadOk = false;
      h.crashed = false;
      h.loadFails++;
      h.failText = kind === 'proxy' ? T('代理连不上：{0}', text) : kind === 'cert' ? T('安全证书有问题：{0}', text) : kind === 'net' ? T('网络不通：{0}', text) : text;
      entry.error = text;
      connLog(acc, 'load-fail', { ...(data || {}), n: h.loadFails });
      scheduleRetry(health.stepDelay(h.authBad ? health.AUTH_RETRY_STEPS : health.RETRY_STEPS, h.loadFails - 1));
      refresh(acc, entry);
      emit();
    };
    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = ABORTED（正常的重复加载、被我们拦下的跳转）
      loadFailed(String(desc || 'ERR') + ' (' + code + ')', health.failKind(code, desc), { code, desc: String(desc || '').slice(0, 60) });
    });
    // 主页面换了一个新文档（刚打开 / 刷新）：旧页面的长连接、应答记录都作废
    wc.on('did-navigate', (e, url, code) => {
      h.sockets.clear();
      h.wsOkAt = 0;
      h.wsFailSince = 0;
      h.wsFails = 0;
      h.pongSeen = false;
      h.pongAt = Date.now();
      h.page = '';
      h.pageSince = 0;
      h.hung = false;
      h.crashed = false;
      h.proxyDownSince = 0;
      h.proxyFails = 0;
      if (code >= 400) return loadFailed('HTTP ' + code, 'other', { http: code }); // 服务器 / 代理回了错误页
      if (allowedNavigation(url)) h.loadOk = true;
    });
    wc.on('did-finish-load', () => {
      // 加载失败后内核会显示一张错误页，那张错误页“加载完成”也会走到这里——不算数
      if (!h.loadOk) {
        // 人正看着这个账号（一片空白）：在页面上说明原因
        if (acc.id === activeId && h.failText)
          setTimeout(() => {
            const st = alive() && !h.loadOk && acc.id === activeId ? statusOf(entry, Date.now()) : null;
            if (st) toastTo(wc, '⚠ ' + st.text, 'error');
          }, 1200);
        return;
      }
      if (h.loadFails) connLog(acc, 'load-ok', { after: h.loadFails });
      clearTimeout(h.retryTimer);
      h.retryTimer = null;
      h.loadFails = 0;
      h.failText = '';
      h.loadedAt = Date.now();
      entry.error = '';
      refresh(acc, entry);
      emit();
    });
    // ---- 页面进程崩溃（内存不够时最常见）：自动重新打开 ----
    wc.on('render-process-gone', (e, details) => {
      const reason = String((details && details.reason) || '');
      if (!alive() || reason === 'clean-exit') return;
      const now = Date.now();
      const forced = h.hung; // 是我们发现它卡死后主动结束的
      h.crashed = true;
      h.loadOk = false;
      h.crashes = h.crashes.filter((t) => now - t < 10 * 60 * 1000);
      h.crashes.push(now);
      entry.error = T('页面崩溃：{0}', reason);
      connLog(acc, forced ? 'hung-killed' : 'crash', { reason, exit: details && details.exitCode, n: h.crashes.length });
      clearTimeout(h.crashTimer);
      h.crashTimer = setTimeout(() => {
        h.crashTimer = null;
        if (!alive()) return;
        connLog(acc, 'crash-reload', {});
        try {
          wc.reload();
        } catch (_) {}
      }, health.stepDelay(health.CRASH_STEPS, h.crashes.length - 1));
      refresh(acc, entry);
      emit();
    });
    wc.on('unresponsive', () => connLog(acc, 'unresponsive', {}));
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
    Promise.resolve(wc.loadURL(opts.url, { userAgent: opts.userAgent })).catch(() => {}); // 失败了由上面的 did-fail-load 接手重试
    return entry;
  }

  function destroyView(id) {
    const v = views.get(id);
    if (!v) return;
    clearTimeout(v.h.retryTimer);
    clearTimeout(v.h.crashTimer);
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
      let settled = false;
      let timer = null;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(v);
      };
      const req = net.request({ url, session: ses, useSessionCookies: false });
      timer = setTimeout(() => {
        try {
          req.abort();
        } catch (_) {}
        done(reject, new Error(T('连接超时（代理可能不可用）')));
      }, timeoutMs || 15000);
      let asked = 0;
      req.on('login', (authInfo, callback) => {
        if (auth && auth.username && asked++ < 2) return callback(auth.username, auth.password || '');
        // 代理不认这组用户名密码（或者根本没填）：到此为止，直接中止请求。
        // 不能用“不带参数调用 callback”来放弃：那样内核会先交回一个 407 的回应、紧接着又在这个回应上报错——
        // 以前这里没接住这个错，主进程会弹出“JavaScript error”的错误框并卡住，直到有人点掉（点“检测 IP”而代理要密码、账号没填时就会这样）
        try {
          req.abort();
        } catch (_) {}
        done(reject, new Error(T('代理用户名或密码错误（407）')));
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString()));
        res.on('error', (err) => done(reject, new Error(T('网络错误：') + String((err && err.message) || err))));
        res.on('end', () => {
          if (res.statusCode === 407) return done(reject, new Error(T('代理用户名或密码错误（407）')));
          try {
            done(resolve, JSON.parse(body));
          } catch (_) {
            done(reject, new Error(T('返回内容无法识别（HTTP {0}）', res.statusCode)));
          }
        });
      });
      req.on('error', (err) => {
        const m = String((err && err.message) || err);
        done(reject, new Error(/PROXY|TUNNEL|SOCKS/i.test(m) ? T('连不上代理：') + m : T('网络错误：') + m));
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
      try {
        ses.setSpellCheckerEnabled(false);
      } catch (_) {}
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
    // 键盘焦点给当前显示的账号。不这样做的话焦点落在最后创建的那个账号上——而它是隐藏着的
    const cur = views.get(activeId);
    if (cur) {
      try {
        cur.view.webContents.focus();
      } catch (_) {}
    }
    // 定时巡查各账号的连接状况
    clearInterval(tickTimer);
    tickAt = Date.now();
    tickTimer = setInterval(tick, TIMES.tick);
    opts.win.on('closed', shutdown);
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
    if (v) {
      v.view.webContents.focus();
      // 切到一个有问题的账号：在页面上直接说明原因（页面进程还活着才显示得出来；崩溃 / 卡死的几秒后会自动重开）
      const st = statusOf(v, Date.now());
      if (st) toastTo(v.view.webContents, '⚠ ' + st.text, st.level === 'err' ? 'error' : 'warn');
    }
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
          reloadEntry(v);
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

  // 重新加载一个账号的页面（手动刷新、改了代理）。等于“现在就再试一次”：之前“代理不认密码、先歇一会儿”的结论作废
  function reloadEntry(v) {
    const wc = v.view.webContents;
    v.h.auth.ok();
    v.h.authBad = false;
    v.h.authNone = false;
    v.h.stuck = false;
    v.h.stuckReloads = [];
    v.h.proxyAnswers = false;
    v.h.proxyDownSince = 0;
    v.h.proxyFails = 0;
    try {
      // 上一次没加载出来（现在显示的是错误页）：直接打开聊天网站；否则普通刷新
      if (v.h.loadOk) wc.reload();
      else Promise.resolve(wc.loadURL(opts.url, { userAgent: opts.userAgent })).catch(() => {});
    } catch (_) {}
  }
  function reload(id) {
    const v = views.get(id || activeId);
    if (v) reloadEntry(v);
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
    notePong,
    wake,
    shutdown,
    proxyAuthFor,
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
