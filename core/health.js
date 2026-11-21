// 账号“还连着吗”：重试的节奏、代理验证的节制、日志的限量（不依赖 Electron，可单测）
//
// 背景：账号的页面一旦悄悄断了线（代理抽风、网页没加载出来、页面进程崩溃……），这个账号就收不到消息，
// 而账号大多数时候是隐藏在后台的，没人看得见。这里的规则都是为了一件事：断了能自己恢复，恢复不了要让人看得见。
'use strict';

// 页面没加载出来：先快后慢地重试，之后每分钟一次，一直试到成功（秒）
const RETRY_STEPS = [3, 8, 20, 45, 60];
// 代理不认用户名密码：放慢。反复拿不对的密码去试，有的代理商会把这台电脑当成在撞密码而封掉
const AUTH_RETRY_STEPS = [60, 120, 300];
// 页面进程崩溃：马上重开；连着崩就越等越久
const CRASH_STEPS = [2, 10, 30, 60, 120, 300];

// 各种“等多久才算数”（毫秒）。放在一个对象里，测试时可以调短
const TIMES = {
  tick: 15 * 1000, // 多久巡查一次（顺带问每个页面一声“还在吗”）
  offlineAfter: 90 * 1000, // 长连接连着失败这么久 → 标成“断线”
  hungAfter: 150 * 1000, // 页面这么久不应答 → 当它卡死了
  stuckAfter: 180 * 1000, // 页面加载完这么久还没连过聊天服务器 → 重新加载
  loginAfter: 120 * 1000, // 停在登录 / 扫码界面这么久 → 标成“没登录”
  alertAfter: 60 * 1000, // 问题持续这么久才弹系统通知（一闪而过的不打扰）
  alertAgain: 30 * 60 * 1000, // 同一个账号的问题，最多半小时提醒一次
  authForget: 10 * 60 * 1000, // 这么久没再被代理拒绝 → 不再显示“代理不认密码”
  keepEvery: 60 * 1000, // 看不到长连接的账号（见 accounts.js 的 keepProxy）：多久经代理探一次
};

function stepDelay(steps, n) {
  const i = Math.min(Math.max(parseInt(n, 10) || 0, 0), steps.length - 1);
  return steps[i] * 1000;
}

/**
 * 代理验证的节制。代理要用户名密码时内核会来问（login 事件）：
 *   · 第一次问（first === true）：照答。
 *   · 刚答过又来问（上一次给的用户名密码被拒了）：半分钟内最多再答 3 次——代理偶尔抽风拒一次，再答就过了；
 *     还是不行就歇一会儿（1 分钟 → 2 分钟 → 5 分钟），歇过之后每次只试 1 次，直到有一次成功（ok()）才恢复正常。
 * 以前的做法是“每个页面只答一次”：代理抽一次风，这个账号就再也连不上，直到重新加载页面。
 *
 * ask(now, first) 返回：
 *   'answer'  这次照答
 *   'locked'  不答，而且刚刚进入歇息期（调用方据此记一条“代理不认密码”）
 *   'wait'    不答（还在歇息期里）
 */
function createAuthGate() {
  let retries = []; // 被拒之后又答的时间点
  let burst = []; // 所有答过的时间点（保险：10 秒内答了 20 次以上，不管什么原因都先停）
  let lockUntil = 0;
  let strikes = 0;
  const lock = (now) => {
    strikes++;
    lockUntil = now + stepDelay(AUTH_RETRY_STEPS, strikes - 1);
    retries = [];
    return 'locked';
  };
  return {
    ask(now, first) {
      if (now < lockUntil) return 'wait';
      burst = burst.filter((t) => now - t < 10000);
      if (burst.length >= 20) return lock(now);
      if (first !== true) {
        retries = retries.filter((t) => now - t < 30000);
        if (retries.length >= (strikes > 0 ? 1 : 3)) return lock(now);
        retries.push(now);
      }
      burst.push(now);
      return 'answer';
    },
    // 有请求经过代理成功了：说明用户名密码没问题
    ok() {
      retries = [];
      lockUntil = 0;
      strikes = 0;
    },
    state: () => ({ strikes, lockUntil }),
  };
}

/**
 * 日志限量：每个账号每小时最多记 max 条，多出来的只计数；下一个小时开始时补一条“上个小时还有 N 条没记”。
 * 软件常年开着，不能按“每次运行最多 N 条”来限——那样第一天记满，之后真出事反而没记录。
 * take(key, now) 返回：true（可以记）/ false（这条不记）；dropped(key, now) 取出并清零“没记的条数”
 */
function createLogBudget(max, windowMs) {
  const m = new Map();
  const slot = (key, now) => {
    let s = m.get(key);
    if (!s || now - s.start >= windowMs) {
      s = { start: now, n: 0, dropped: 0, carried: s ? s.dropped : 0 };
      m.set(key, s);
      if (m.size > 500) m.delete(m.keys().next().value);
    }
    return s;
  };
  return {
    take(key, now) {
      const s = slot(key, now);
      if (s.n >= max) {
        s.dropped++;
        return false;
      }
      s.n++;
      return true;
    },
    dropped(key, now) {
      const s = slot(key, now);
      const n = s.carried;
      s.carried = 0;
      return n;
    },
  };
}

// 内核的错误码 → 给人看的原因。level：'net' 网络 / 'proxy' 代理 / 'cert' 证书 / 'other'
function failKind(code, desc) {
  const d = String(desc || '');
  const c = parseInt(code, 10) || 0;
  if (/PROXY|TUNNEL|SOCKS/i.test(d) || c === -111 || c === -130 || c === -336) return 'proxy';
  if (/CERT|SSL/i.test(d) || (c <= -200 && c > -220)) return 'cert';
  if (/INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED/i.test(d)) return 'net';
  if (/TIMED_OUT|CONNECTION_|EMPTY_RESPONSE/i.test(d)) return 'net';
  return 'other';
}

// 这个地址是不是聊天网站自己的（本身，或它的子域名）——只看这些地址上的长连接
function siteHost(url, allowedHosts) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return (allowedHosts || []).some((a) => h === a || h.endsWith('.' + a)) ? h : '';
  } catch (_) {
    return '';
  }
}

module.exports = { TIMES, RETRY_STEPS, AUTH_RETRY_STEPS, CRASH_STEPS, stepDelay, createAuthGate, createLogBudget, failKind, siteHost };
