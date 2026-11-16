// 诊断日志用的小工具：把网址、内核打印的报错“脱敏”后再记（不依赖 Electron，方便单元测试）
// 原则：只留“协议 + 域名”，路径、参数、文件名一律不留；网页自己打印的内容一律不记
'use strict';

// 网址只留“协议 + 域名”
function siteOf(url) {
  try {
    const str = String(url || '');
    if (/^blob:/i.test(str)) return 'blob:' + new URL(str.slice(5)).host;
    const u = new URL(str);
    return u.protocol + '//' + u.host;
  } catch (_) {
    return '?'; // 认不出来的一律不记原文
  }
}

// 浏览器内核自己打印的“被拦下 / 被拒绝 / 加载失败”一类的话，记到诊断日志里（网址只留域名）。网页自己打印的内容一律不记
const CONSOLE_KEEP = /^(Refused to |Blocked |Unsafe attempt|Not allowed to |Access to |Failed to load resource|Mixed Content|Permissions policy violation|Uncaught \(in promise\) (NotAllowedError|SecurityError|NotSupportedError|DataCloneError|InvalidStateError)|(GET|POST|PUT|HEAD|DELETE|PATCH|OPTIONS) \S+ net::ERR_\w+$)/;
function cleanConsole(msg) {
  const str = String(msg || '');
  if (!CONSOLE_KEEP.test(str)) return '';
  let out = str.replace(/(blob:)?[a-z][a-z0-9+.-]*:\/\/[^\s'")<>]+/gi, (u) => siteOf(u));
  // data: / javascript: / mailto: / tel: 这类地址后面跟的就是内容本身（网页片段、电话、邮箱），而且里面可以有空格和引号，
  // 分不清到哪里结束——从它开始整段截掉，只留下“是哪一类地址”
  const cut = out.search(/\b(data|javascript|mailto|tel|sms|whatsapp|tg|intent|market):/i);
  if (cut >= 0) out = out.slice(0, cut) + out.slice(cut).match(/^[a-z]+/i)[0].toLowerCase() + ':…';
  return out.replace(/\s+/g, ' ').slice(0, 260);
}

module.exports = { siteOf, cleanConsole };
