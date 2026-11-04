// 代理配置：解析用户粘贴的代理字符串、生成 Chromium 的代理规则（不依赖 Electron，可单测）
'use strict';
const { T } = require('./i18n');

const TYPES = ['none', 'http', 'https', 'socks5', 'socks4'];
// 'system' 只用于“API 请求代理”：跟随系统代理设置
const API_TYPES = ['none', 'system', 'http', 'https', 'socks5', 'socks4'];

/**
 * 解析常见的代理写法，返回 { type, host, port, username, password } 或 null
 * 支持：
 *   socks5://user:pass@1.2.3.4:1080
 *   http://1.2.3.4:8080
 *   1.2.3.4:8080
 *   1.2.3.4:8080:user:pass
 *   user:pass@1.2.3.4:8080
 *   user:pass:1.2.3.4:8080
 */
function parseProxyString(raw, defaultType) {
  let s = String(raw || '').trim();
  if (!s) return null;
  let type = defaultType && TYPES.includes(defaultType) && defaultType !== 'none' ? defaultType : 'http';
  const m = s.match(/^([a-z0-9]+):\/\//i);
  if (m) {
    const t = m[1].toLowerCase();
    type = t === 'socks' || t === 'socks5h' ? 'socks5' : t;
    if (!TYPES.includes(type) || type === 'none') return null;
    s = s.slice(m[0].length);
  }
  s = s.replace(/\/+$/, '');
  let username = '';
  let password = '';
  let hostPort = s;
  const at = s.lastIndexOf('@');
  if (at !== -1) {
    const cred = s.slice(0, at);
    hostPort = s.slice(at + 1);
    const c = cred.indexOf(':');
    username = c === -1 ? cred : cred.slice(0, c);
    password = c === -1 ? '' : cred.slice(c + 1);
  }
  const parts = hostPort.split(':');
  let host;
  let port;
  if (at === -1 && parts.length === 4) {
    // host:port:user:pass 或 user:pass:host:port
    if (/^\d+$/.test(parts[1])) {
      [host, port, username, password] = parts;
    } else if (/^\d+$/.test(parts[3])) {
      [username, password, host, port] = parts;
    } else {
      return null;
    }
  } else if (parts.length === 2) {
    [host, port] = parts;
  } else {
    return null;
  }
  host = String(host).trim();
  port = parseInt(port, 10);
  if (!host || !/^[a-z0-9.\-_\[\]]+$/i.test(host) || !(port > 0 && port < 65536)) return null;
  try {
    username = decodeURIComponent(username);
    password = decodeURIComponent(password);
  } catch (_) {}
  return { type, host, port, username, password };
}

function isProxyOn(p) {
  return !!(p && p.type && p.type !== 'none' && p.host && p.port);
}

/** 生成 session.setProxy 的参数 */
function proxyConfig(p) {
  if (p && p.type === 'system') return { mode: 'system' };
  if (!isProxyOn(p)) return { mode: 'direct' };
  return { mode: 'fixed_servers', proxyRules: `${p.type}://${p.host}:${p.port}`, proxyBypassRules: '<local>' };
}

/** 检查配置，返回错误说明或 null */
function validateProxy(p) {
  if (!p || !p.type || p.type === 'none' || p.type === 'system') return null;
  if (!TYPES.includes(p.type)) return T('不支持的代理类型');
  if (!p.host) return T('请填写代理地址');
  const port = parseInt(p.port, 10);
  if (!(port > 0 && port < 65536)) return T('端口不正确');
  if ((p.type === 'socks5' || p.type === 'socks4') && (p.username || p.password)) {
    return T('SOCKS 代理不支持用户名密码（浏览器内核限制）。请改用 HTTP 类型，或让代理商改成 IP 白名单方式');
  }
  return null;
}

/** 显示用：socks5://1.2.3.4:1080（不显示密码） */
function proxyLabel(p) {
  if (p && p.type === 'system') return T('跟随系统代理');
  if (!isProxyOn(p)) return T('直连（不使用代理）');
  return `${p.type.toUpperCase()} ${p.host}:${p.port}${p.username ? T('（需验证）') : ''}`;
}

module.exports = { TYPES, API_TYPES, parseProxyString, isProxyOn, proxyConfig, validateProxy, proxyLabel };
