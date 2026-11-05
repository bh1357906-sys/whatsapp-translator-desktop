// 页面侧共享核心（在 WhatsApp Web / Telegram Web 页面里运行，隔离环境）
// 负责：扫描消息并显示翻译行、按聊天记住语言、拦截发送并翻译、工具栏和面板
'use strict';

const { ipcRenderer } = require('electron');
const lang = require('./lang');
const i18n = require('./i18n');
const { T } = i18n;
const langLabel = (n) => (i18n.getLang() === 'en' ? n : lang.langLabel(n));

const ZW = /[​‌‍‎‏⁠﻿]/g;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 读取富文本：表情图片取 alt（修复旧版 innerText 丢表情），<br>/段落变换行，跳过指定元素
function readRichText(root, skipSel) {
  if (!root) return '';
  let out = '';
  const skip = '.wa-tr-line' + (skipSel ? ',' + skipSel : '');
  (function walk(n) {
    if (n.nodeType === 3) {
      out += n.nodeValue;
      return;
    }
    if (n.nodeType !== 1) return;
    if (n.matches(skip)) return;
    const tag = n.tagName;
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    if (tag === 'IMG') {
      out += n.getAttribute('alt') || '';
      return;
    }
    if (tag === 'STYLE' || tag === 'SCRIPT') return;
    const block = tag === 'DIV' || tag === 'P' || tag === 'LI';
    if (block && out && !out.endsWith('\n')) out += '\n';
    for (const c of n.childNodes) walk(c);
    if (block && out && !out.endsWith('\n')) out += '\n';
  })(root);
  return out.replace(ZW, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function waitFor(cond, timeoutMs, step) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function tick() {
      let ok = false;
      try {
        ok = !!cond();
      } catch (_) {}
      if (ok) return resolve(true);
      if (Date.now() - t0 >= timeoutMs) return resolve(false);
      setTimeout(tick, step || 40);
    })();
  });
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function selectAllIn(el) {
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_) {}
}

function errText(err) {
  const m = String((err && err.message) || err || '');
  // ipc 会包一层 "Error invoking remote method 'x': Error: ..."
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

const CSS = `
.wa-tr-line{display:block;margin:4px 0 2px;padding:5px 10px;font-size:13px;line-height:1.45;color:#54656f;
  background:rgba(0,168,132,.08);border-left:3px solid #00a884;border-radius:0 8px 8px 0;white-space:pre-wrap;
  word-break:break-word;max-width:100%;box-sizing:border-box;user-select:text;cursor:text;font-family:inherit}
.wa-tr-line.wa-tr-out{border-left:none;border-right:3px solid #25d366;border-radius:8px 0 0 8px;text-align:right}
.wa-tr-line.wa-tr-pending{opacity:.55;font-style:italic}
.wa-tr-line.wa-tr-error{color:#c62828;background:rgba(198,40,40,.08);border-color:#c62828;cursor:pointer}
.wa-tr-line.wa-tr-voice-btn{cursor:pointer;display:inline-block;color:#00a884;font-weight:600}
.wa-tr-line.wa-tr-voice-btn:hover{background:rgba(0,168,132,.18)}
.wa-tr-line .trx-vt{font-size:12px;color:#8696a0;margin-bottom:2px}
.wa-tr-line.wa-tr-img-btn{cursor:pointer;display:inline-block;color:#0984e3;font-weight:600;border-color:#0984e3;background:rgba(9,132,227,.08)}
.wa-tr-line.wa-tr-img-btn:hover{background:rgba(9,132,227,.18)}
.wa-tr-line.wa-tr-manual{border-left-style:double}
.wa-tr-line .trx-fb{display:none;position:absolute;right:6px;top:3px;gap:4px}
.wa-tr-line{position:relative}
.wa-tr-line:hover .trx-fb{display:flex}
.wa-tr-line .trx-fb button{font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid #cfd8dc;background:#fff;color:#54656f;cursor:pointer;line-height:1.4}
.wa-tr-line .trx-fb button:hover{background:#e7f8f2;border-color:#00a884;color:#00a884}
.wa-tr-line textarea.trx-fix{width:100%;box-sizing:border-box;border:1px solid #00a884;border-radius:6px;padding:6px;font:inherit;resize:vertical;outline:none;color:#111;background:#fff;margin-top:4px}
.wa-tr-line .trx-fix-btns{display:flex;gap:6px;margin-top:4px;align-items:center;font-size:12px}
.wa-tr-line .trx-fix-btns button{font-size:12px;padding:2px 8px;border-radius:4px;border:1px solid #ccc;background:#f0f2f5;cursor:pointer}
.wa-tr-line .trx-fix-btns button.trx-primary{background:#00a884;border-color:#00a884;color:#fff}
#trx-quick{position:fixed;z-index:2147483002;background:#fff;color:#111;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);width:min(520px,80vw);max-height:40vh;overflow-y:auto;display:none;font:13px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#trx-quick .trx-q{padding:8px 12px;cursor:pointer;border-bottom:1px solid #f0f2f5;white-space:pre-wrap;word-break:break-word}
#trx-quick .trx-q:hover,#trx-quick .trx-q.trx-cur{background:#e7f8f2}
#trx-quick .trx-qh{padding:6px 12px;font-size:11px;color:#8696a0;background:#f7f9fa;position:sticky;top:0}
.dark .wa-tr-line,.night .wa-tr-line{color:#d1d7db;background:rgba(0,168,132,.16)}
#trx-bar{position:fixed;right:14px;bottom:110px;z-index:2147483000;display:flex;flex-direction:column-reverse;gap:10px}
#trx-bar button.trx-fab{width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;color:#fff;
  font-size:15px;font-weight:700;box-shadow:0 3px 10px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;
  position:relative;font-family:inherit;padding:0}
#trx-bar button.trx-fab:hover{filter:brightness(.92)}
#trx-bar button.trx-fab.trx-off{opacity:.45}
#trx-bar.trx-dragging button.trx-fab{cursor:grabbing;box-shadow:0 6px 18px rgba(0,0,0,.45)}
.trx-panel{position:fixed;right:70px;bottom:110px;z-index:2147483001;background:#fff;color:#111;border-radius:12px;
  box-shadow:0 6px 24px rgba(0,0,0,.35);width:300px;max-height:70vh;overflow-y:auto;display:none;font:13px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.trx-panel .trx-h{padding:10px 14px;border-bottom:1px solid #eee;font-weight:700;display:flex;justify-content:space-between;align-items:center;gap:6px}
.trx-panel .trx-sub{font-weight:400;color:#667781;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trx-panel .trx-item{padding:9px 14px;cursor:pointer;display:flex;justify-content:space-between}
.trx-panel .trx-item:hover{background:#f0f2f5}
.trx-panel .trx-item.trx-cur{background:#e7f8f2;font-weight:700}
.trx-panel .trx-row{padding:8px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #eee;cursor:pointer}
.trx-panel button.trx-btn{padding:3px 9px;background:#f0f2f5;color:#333;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-size:12px}
.trx-panel button.trx-btn.trx-primary{background:#d43f81;border-color:#d43f81;color:#fff}
.trx-panel input.trx-input{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:12px;box-sizing:border-box}
#trx-preview{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483002;width:min(560px,92vw);background:#fff;color:#111;
  border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.4);padding:12px 14px;font:14px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#trx-preview .trx-pv-h{font-weight:700;margin-bottom:6px}
#trx-preview .trx-pv-orig{font-size:12px;color:#667781;margin-bottom:6px;white-space:pre-wrap;word-break:break-word}
#trx-preview textarea{width:100%;box-sizing:border-box;border:1px solid #00a884;border-radius:8px;padding:8px;font:inherit;resize:vertical;outline:none}
#trx-preview .trx-pv-back{font-size:13px;color:#2e7d32;background:#e8f5e9;border-radius:6px;padding:6px 8px;margin-top:6px;white-space:pre-wrap;word-break:break-word}
#trx-preview .trx-pv-btns{display:flex;align-items:center;gap:8px;margin-top:10px}
#trx-preview .trx-pv-btns span{flex:1;font-size:12px;color:#8696a0}
#trx-preview button{padding:6px 14px;border-radius:6px;border:1px solid #ccc;background:#f0f2f5;cursor:pointer;font:inherit}
#trx-preview button.trx-pv-send{background:#00a884;border-color:#00a884;color:#fff}
#trx-vs{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483002;width:min(560px,92vw);background:#fff;color:#111;
  border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.4);padding:12px 14px;font:14px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#trx-vs .trx-pv-h{font-weight:700;margin-bottom:6px}
#trx-vs .trx-pv-orig{font-size:12px;color:#667781;margin-bottom:6px;white-space:pre-wrap;word-break:break-word}
#trx-vs textarea{width:100%;box-sizing:border-box;border:1px solid #1e88e5;border-radius:8px;padding:8px;font:inherit;resize:vertical;outline:none}
#trx-vs .trx-vs-row{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;font-size:13px}
#trx-vs .trx-pv-h select{font-weight:400;max-width:220px}
#trx-vs select{padding:4px 6px;border:1px solid #ccc;border-radius:6px;font:inherit;font-size:13px;background:#fff;color:#111}
#trx-vs button{padding:6px 14px;border-radius:6px;border:1px solid #ccc;background:#f0f2f5;cursor:pointer;font:inherit}
#trx-vs button.trx-vs-send{background:#1e88e5;border-color:#1e88e5;color:#fff}
#trx-vs button:disabled{opacity:.5;cursor:default}
#trx-vs .trx-vs-status{flex:1;font-size:12px;color:#8696a0}
#trx-toasts{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483002;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.trx-toast{pointer-events:auto;max-width:560px;padding:9px 14px;border-radius:8px;background:#323739;color:#fff;font:13px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);white-space:pre-wrap;word-break:break-word}
.trx-toast.trx-error{background:#b3261e}
.trx-toast.trx-warn{background:#8a5a00}
.trx-toast button{margin-left:10px;background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:4px;padding:2px 8px;cursor:pointer}
`;

function createTranslatorUI(adapter) {
  let settings = null;
  // 插件更新 / 重新加载后，旧脚本会失去和后台的联系（“孤儿”）：它要停下来、清理掉自己的按钮，让新脚本接手
  let dead = false;
  const docOn = (type, fn, opts) =>
    document.addEventListener(
      type,
      (e) => {
        if (!dead) fn(e);
      },
      opts
    );
  // 发送拦截挂在 window 的捕获阶段：比聊天网页自己在 document 上注册的任何监听都先执行
  const winOn = (type, fn) =>
    window.addEventListener(
      type,
      (e) => {
        if (!dead) fn(e);
      },
      true
    );
  const chat = { key: null, name: null, aliases: [], number: '' };
  let chatLang = 'English';
  let chatLangReady = Promise.resolve();
  let chatLangFromContact = false;
  let chatTone = 'casual';
  let tones = { casual: '日常口语', formal: '正式商务', warm: '亲切热情', brief: '简短直接' };
  let lastInfos = []; // 当前聊天屏幕上的消息（按顺序），用作发送时的上下文
  const detectHistory = new Map(); // 聊天 → 最近识别到的对方语言
  const detectDismissed = new Set(); // 用户说“不用切换”的 聊天|语言

  let msgState = new WeakMap(); // 消息元素 → { key, status }
  let resultCache = new Map(); // key → 译文（null = 不需要显示）
  const messageListeners = [];
  const chatListeners = [];
  const settingsListeners = [];
  const readyListeners = [];

  let busy = false;
  let bypassUntil = 0;
  let lastTranslated = null; // 最近一次写进输入框的译文（60 秒内按回车不再重复翻译）
  let lastComposer = null;
  const startedAt = Date.now();
  const seenMsgKeys = new Set(); // 已经见过的消息 key（用于判断“新来的消息”→ 系统通知）
  let lastBudgetToast = 0;

  const LAST_TRANSLATED_TTL = 60000;
  function isLastTranslated(text) {
    return !!(lastTranslated && Date.now() - lastTranslated.at < LAST_TRANSLATED_TTL && lang.looseEqual(text, lastTranslated.text));
  }
  // 发送键：enter / ctrlEnter（和聊天软件自己的设置保持一致）
  const sendKeyMode = () => (settings && settings.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter');
  // 是不是“发送”这个按键组合；“发原文”则是另一组合（enter 模式：Ctrl/⌘+Enter；ctrlEnter 模式：Alt+Enter）
  function keyKind(e) {
    // 输入法正在组字（isComposing / key=Process）时不管；注意有些输入法在组字刚结束的那一下回车 keyCode 仍是 229，
    // 所以只要 key 是 Enter 且不在组字中就按回车处理
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return null;
    if (sendKeyMode() === 'ctrlEnter') {
      if (e.altKey && !e.ctrlKey && !e.metaKey) return 'raw';
      if (e.ctrlKey || e.metaKey) return 'send';
      return 'newline';
    }
    if (e.altKey) return null;
    if (e.ctrlKey || e.metaKey) return 'raw';
    return 'send';
  }
  function budgetNotice(res) {
    if (!res || !res.budget) return;
    if (Date.now() - lastBudgetToast < 3600000) return;
    lastBudgetToast = Date.now();
    if (res.budget === 'fallback') toast(T('本月翻译用量已超预算，已自动切换到 DeepSeek（设置 → 用量与预算）'), 'warn', { ms: 8000 });
    else toast(T('本月翻译用量已超过你设置的预算（设置 → 用量与预算）'), 'warn', { ms: 8000 });
  }

  // ---------------- 提示 ----------------
  let toastBox = null;
  function toast(msg, type, opts) {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.id = 'trx-toasts';
      document.body.appendChild(toastBox);
    }
    const t = document.createElement('div');
    t.className = 'trx-toast' + (type ? ' trx-' + type : '');
    t.textContent = msg;
    if (opts && opts.actions) {
      opts.actions.forEach((a) => {
        const b = document.createElement('button');
        b.textContent = a.label;
        b.onclick = () => {
          t.remove();
          try {
            a.fn();
          } catch (_) {}
        };
        t.appendChild(b);
      });
    }
    if (opts && opts.copy) {
      const b = document.createElement('button');
      b.textContent = T('复制译文');
      b.onclick = () => {
        navigator.clipboard.writeText(opts.copy).catch(() => {});
        b.textContent = T('已复制');
      };
      t.appendChild(b);
    }
    toastBox.appendChild(t);
    const ms = (opts && opts.ms) || (type === 'error' ? 6000 : 2500);
    if (ms > 0) setTimeout(() => t.remove(), ms);
    return t;
  }

  // ---------------- 工具栏 + 面板 ----------------
  const bar = document.createElement('div');
  bar.id = 'trx-bar';
  const panels = [];

  function addFab({ id, text, title, color, onClick, atStart }) {
    const b = document.createElement('button');
    b.className = 'trx-fab';
    if (id) b.id = id;
    b.textContent = text;
    b.title = title || '';
    b.style.background = color || '#00a884';
    // mousedown 不抢输入框焦点；按住拖动可以移动整个工具栏
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startDrag(e);
    });
    b.addEventListener('click', (e) => {
      if (justDragged) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onClick(e);
    });
    if (atStart) bar.insertBefore(b, bar.firstChild);
    else bar.appendChild(b);
    return b;
  }

  // ---- 拖动 ----
  let justDragged = false;
  function barPos() {
    const r = bar.getBoundingClientRect();
    return { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) };
  }
  function applyBarPos(pos) {
    if (!pos) {
      bar.style.right = '';
      bar.style.bottom = '';
    } else {
      const maxR = Math.max(0, window.innerWidth - 60);
      const maxB = Math.max(0, window.innerHeight - bar.offsetHeight - 6);
      bar.style.right = Math.min(Math.max(4, pos.right), maxR) + 'px';
      bar.style.bottom = Math.min(Math.max(4, pos.bottom), maxB) + 'px';
    }
    panels.forEach((p) => {
      if (isOpen(p)) positionPanel(p);
    });
  }
  function startDrag(e) {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, ...barPos() };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      moved = true;
      bar.classList.add('trx-dragging');
      applyBarPos({ right: start.right - dx, bottom: start.bottom - dy });
    };
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      bar.classList.remove('trx-dragging');
      if (moved) {
        justDragged = true;
        setTimeout(() => (justDragged = false), 50);
        ipcRenderer
          .invoke('tr:patch-settings', { toolbarPos: barPos() })
          .then((v) => {
            if (v) settings = v;
          })
          .catch(() => {});
      }
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }
  window.addEventListener('resize', () => settings && settings.toolbarPos && applyBarPos(settings.toolbarPos));

  // 面板跟着工具栏走：工具栏在右半边时面板开在左侧，反之开在右侧
  function positionPanel(p) {
    const r = bar.getBoundingClientRect();
    const pw = p.offsetWidth || 300;
    if (r.left > window.innerWidth / 2) {
      p.style.left = '';
      p.style.right = Math.max(4, window.innerWidth - r.left + 12) + 'px';
    } else {
      p.style.right = '';
      p.style.left = Math.min(window.innerWidth - pw - 4, r.right + 12) + 'px';
    }
    const bottom = Math.max(8, Math.min(window.innerHeight - r.bottom, window.innerHeight - 260));
    p.style.bottom = bottom + 'px';
    p.style.maxHeight = Math.max(200, window.innerHeight - bottom - 16) + 'px';
  }

  function createPanel(id) {
    const p = document.createElement('div');
    p.className = 'trx-panel';
    if (id) p.id = id;
    document.body.appendChild(p);
    panels.push(p);
    return p;
  }
  function isOpen(p) {
    return p.style.display === 'block';
  }
  function openPanel(p) {
    panels.forEach((x) => {
      if (x !== p) x.style.display = 'none';
    });
    p.style.display = 'block';
    positionPanel(p);
  }
  function closePanel(p) {
    p.style.display = 'none';
  }
  function togglePanel(p) {
    if (isOpen(p)) closePanel(p);
    else openPanel(p);
    return isOpen(p);
  }

  // 语言面板
  const langPanel = createPanel('trx-lang-panel');
  let langFab, trFab;

  function renderLangPanel() {
    const cur = chatLang;
    let html =
      '<div class="trx-h"><div><div>' + T('对方语言') + '</div><div class="trx-sub">' +
      escapeHtml(chat.name ? T('当前聊天：') + chat.name : T('未识别到当前聊天')) +
      '</div></div></div>';
    html +=
      '<label class="trx-row"><input type="checkbox" data-k="autoTranslateSend"' +
      (settings.autoTranslateSend ? ' checked' : '') +
      '> ' + T('按回车时自动翻译再发送') + '</label>';
    html +=
      '<label class="trx-row"><input type="checkbox" data-k="autoTranslateIncoming"' +
      (settings.autoTranslateIncoming ? ' checked' : '') +
      '> ' + T('自动翻译聊天消息') + '</label>';
    const chk = (k, label) =>
      '<label class="trx-row"><input type="checkbox" data-k="' + k + '"' + (settings[k] ? ' checked' : '') + '> ' + label + '</label>';
    html += chk('previewBeforeSend', T('发送前先预览译文（可修改，并显示意思）'));
    html += chk('autoDetectLang', T('自动识别对方语言'));
    html += chk('useContext', T('结合前几条消息翻译（更准确）'));
    html +=
      '<div class="trx-row" style="cursor:default;display:block"><div style="font-size:12px;color:#667781;margin-bottom:6px">' + T('发送语气（此聊天）') + '</div><div style="display:flex;gap:6px;flex-wrap:wrap">' +
      Object.entries(tones)
        .map(
          ([k, v]) =>
            '<button class="trx-btn' + (k === chatTone ? ' trx-primary' : '') + '" data-tone="' + k + '"' + (k === chatTone ? ' style="background:#00a884;border-color:#00a884"' : '') + '>' + escapeHtml(T(v)) + '</button>'
        )
        .join('') +
      '</div></div>';
    html +=
      '<div class="trx-row" style="cursor:default;color:#667781;font-size:12px">' +
      (chatLangFromContact ? T('此聊天已单独设置语言') : T('此聊天使用默认语言：') + escapeHtml(langLabel(settings.defaultTheirLang))) +
      '</div>';
    html +=
      '<div class="trx-row" style="cursor:default;color:#667781;font-size:12px;display:block">' +
      T('Ctrl+Enter（Mac：⌘+Enter）直接发原文，不翻译') + '<br><span id="trx-usage">' + T('今日用量：读取中…') + '</span>' +
      (settings.toolbarPos ? ' · <a href="#" id="trx-reset-pos" style="color:#00a884">' + T('按钮回到默认位置') + '</a>' : '') +
      '</div>';
    lang.LANGUAGES.forEach((l) => {
      html +=
        '<div class="trx-item' + (l.name === cur ? ' trx-cur' : '') + '" data-lang="' + escapeHtml(l.name) + '"><span>' +
        escapeHtml(langLabel(l.name)) + '</span><span style="color:#999">' + escapeHtml(l.code) + '</span></div>';
    });
    langPanel.innerHTML = html;
    langPanel.querySelectorAll('input[data-k]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        settings = await ipcRenderer.invoke('tr:patch-settings', { [cb.dataset.k]: cb.checked });
        applySettings(settings);
      });
    });
    langPanel.querySelectorAll('button[data-tone]').forEach((b) => {
      b.addEventListener('click', async () => {
        await setChatTone(b.dataset.tone);
        renderLangPanel();
      });
    });
    const reset = langPanel.querySelector('#trx-reset-pos');
    if (reset)
      reset.addEventListener('click', async (e) => {
        e.preventDefault();
        settings = await ipcRenderer.invoke('tr:patch-settings', { toolbarPos: null });
        applyBarPos(null);
        renderLangPanel();
      });
    ipcRenderer
      .invoke('tr:get-usage')
      .then((u) => {
        const el = langPanel.querySelector('#trx-usage');
        if (el && u) el.textContent = T('今日用量：{0} 次 / {1} tokens（本月 {2}）', u.today.requests, u.today.tokens.toLocaleString(), u.month.tokens.toLocaleString());
      })
      .catch(() => {});
    langPanel.querySelectorAll('.trx-item').forEach((it) => {
      it.addEventListener('click', async () => {
        await setChatLang(it.dataset.lang);
        closePanel(langPanel);
      });
    });
  }

  function updateLangFab() {
    if (!langFab) return;
    langFab.textContent = lang.langCode(chatLang);
    langFab.title = T('对方语言：') + langLabel(chatLang) + T(' · 语气：') + T(tones[chatTone] || '') + (chat.name ? '（' + chat.name + '）' : '') + T(' — 点击切换');
  }
  function updateTrFab() {
    if (!trFab || !settings) return;
    trFab.classList.toggle('trx-off', !settings.autoTranslateSend);
    trFab.title = settings.autoTranslateSend
      ? T('回车自动翻译：开。点此只翻译草稿不发送（Alt+T）')
      : T('回车自动翻译：关（在语言面板里打开）。点此翻译草稿（Alt+T）');
  }

  async function setChatTone(t) {
    if (!tones[t]) return;
    chatTone = t;
    if (chat.key) await ipcRenderer.invoke('tr:set-contact-tone', { key: chat.key, tone: t });
    else toast(T('没识别到当前聊天，语气只对这次有效'), 'warn');
    updateLangFab();
  }

  async function setChatLang(l) {
    chatLang = l;
    if (chat.key) {
      await ipcRenderer.invoke('tr:set-contact-lang', { key: chat.key, lang: l });
      chatLangFromContact = true;
    } else {
      settings = await ipcRenderer.invoke('tr:patch-settings', { defaultTheirLang: l });
      toast(T('没识别到当前聊天，已设为默认语言：') + langLabel(l), 'warn');
    }
    updateLangFab();
    chatListeners.forEach((fn) => fn({ ...chat, lang: chatLang, langChanged: true }));
  }

  // ---------------- 聊天切换 ----------------
  function ensureChat() {
    let c = null;
    try {
      c = adapter.getChat();
    } catch (_) {}
    if (!c || !c.key) return chat;
    if (c.key === chat.key && c.name === chat.name) return chat;
    const changed = c.key !== chat.key && !(chat.aliases || []).includes(c.key) && !(c.aliases || []).includes(chat.key);
    chat.key = c.key;
    chat.name = c.name;
    chat.aliases = c.aliases || [];
    chat.number = c.number || '';
    if (!changed) return chat;
    // 切到新聊天：先立刻用默认语言（不会再沿用上一个人的语言），再异步查这个联系人保存的语言
    chatLang = settings.defaultTheirLang;
    chatLangFromContact = false;
    chatTone = tones[settings.defaultTone] ? settings.defaultTone : 'casual';
    lastInfos = [];
    updateLangFab();
    const keys = [c.key, ...(c.aliases || [])];
    const myKey = c.key;
    chatLangReady = ipcRenderer
      .invoke('tr:get-contact-prefs', keys)
      .then((prefs) => {
        if (chat.key !== myKey) return;
        if (prefs && prefs.lang) {
          chatLang = prefs.lang;
          chatLangFromContact = true;
        }
        if (prefs && prefs.tone && tones[prefs.tone]) chatTone = prefs.tone;
        updateLangFab();
        if (isOpen(langPanel)) renderLangPanel();
      })
      .catch(() => {});
    chatListeners.forEach((fn) => fn({ ...chat, lang: chatLang }));
    return chat;
  }

  // ---------------- 消息翻译 ----------------
  function makeLine(info, text, cls) {
    const line = document.createElement('div');
    line.className = 'wa-tr-line' + (info.incoming ? '' : ' wa-tr-out') + (cls ? ' ' + cls : '');
    line.textContent = text;
    return line;
  }

  // 译文行：鼠标悬停出现「不准」→ 换一种译法 / 手动修正；手动修正过的译文可一键加进词库
  function makeResultLine(el, info, key, text, manual) {
    const line = makeLine(info, text, manual ? 'wa-tr-manual' : '');
    const fb = document.createElement('div');
    fb.className = 'trx-fb';
    const btnRetry = document.createElement('button');
    btnRetry.textContent = T('换一种');
    btnRetry.title = T('觉得不准？让模型换一种译法');
    btnRetry.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      line.classList.add('wa-tr-pending');
      ipcRenderer
        .invoke('tr:translate', { text: info.text, mode: 'read', force: true })
        .then((res) => {
          const v = res && res.text ? res.text : null;
          resultCache.set(key, v);
          const cur = adapter.getMessageInfo(el) || info;
          if (v) putLine(el, cur, key, makeResultLine(el, cur, key, v));
          else removeLine(cur);
        })
        .catch((err) => {
          line.classList.remove('wa-tr-pending');
          toast(T('翻译失败：') + errText(err), 'error');
        });
    };
    const btnFix = document.createElement('button');
    btnFix.textContent = T('修正');
    btnFix.title = T('手动改译文；以后这条消息直接显示你改的');
    btnFix.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      openFixEditor(el, info, key, line, text);
    };
    const btnCopy = document.createElement('button');
    btnCopy.textContent = T('复制');
    btnCopy.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      navigator.clipboard.writeText(text).catch(() => {});
      btnCopy.textContent = T('已复制');
      setTimeout(() => (btnCopy.textContent = T('复制')), 1200);
    };
    fb.append(btnRetry, btnFix, btnCopy);
    line.appendChild(fb);
    return line;
  }

  function openFixEditor(el, info, key, line, text) {
    if (line.querySelector('textarea.trx-fix')) return;
    line.querySelectorAll('.trx-fb').forEach((x) => (x.style.display = 'none'));
    const ta = document.createElement('textarea');
    ta.className = 'trx-fix';
    ta.value = text;
    ta.rows = Math.min(6, Math.max(2, text.split('\n').length + 1));
    const btns = document.createElement('div');
    btns.className = 'trx-fix-btns';
    const save = document.createElement('button');
    save.className = 'trx-primary';
    save.textContent = T('保存');
    const cancel = document.createElement('button');
    cancel.textContent = T('取消');
    let gl = null;
    const shortEnough = info.text.length <= 40 && !/\n/.test(info.text);
    if (shortEnough) {
      gl = document.createElement('label');
      gl.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;color:#54656f';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = info.text.length <= 20;
      gl.append(cb, document.createTextNode(T('也加进词库（以后都这样翻）')));
      gl.cb = cb;
    }
    btns.append(save, cancel);
    if (gl) btns.appendChild(gl);
    line.append(ta, btns);
    ta.focus();
    const stop = (e) => e.stopPropagation();
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') cancel.click();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click();
    });
    ta.addEventListener('keyup', stop);
    ta.addEventListener('click', stop);
    cancel.onclick = (e) => {
      e.stopPropagation();
      putLine(el, adapter.getMessageInfo(el) || info, key, makeResultLine(el, info, key, text, line.classList.contains('wa-tr-manual')));
    };
    save.onclick = async (e) => {
      e.stopPropagation();
      const fixed = ta.value.trim();
      if (!fixed) return cancel.click();
      try {
        await ipcRenderer.invoke('tr:set-translation', { text: info.text, translation: fixed });
        resultCache.set(key, fixed);
        if (gl && gl.cb.checked) {
          const ok = await ipcRenderer.invoke('tr:add-glossary', { source: info.text.trim(), target: fixed });
          toast(ok ? T('已保存，并加进词库') : T('已保存译文（词条太长，没有加进词库）'));
        } else toast(T('已保存译文'));
      } catch (err) {
        toast(T('保存失败：') + errText(err), 'error');
      }
      putLine(el, adapter.getMessageInfo(el) || info, key, makeResultLine(el, info, key, fixed, true));
    };
  }

  function putLine(el, info, key, line) {
    removeLine(info);
    line.dataset.key = key;
    if (adapter.placeLine) adapter.placeLine(info, line);
    else info.mount.appendChild(line);
  }

  // 文字译文行和图片译文行互不影响（一条消息可能既有图又有配文）
  function removeLine(info) {
    info.mount.querySelectorAll('.wa-tr-line:not(.wa-tr-imgline)').forEach((x) => x.remove());
  }

  function findLine(info) {
    return info.mount.querySelector('.wa-tr-line:not(.wa-tr-imgline)');
  }

  // 识别到对方语言：没单独设置过的聊天自动切换（可撤销）；已设置但不一致的给出提示
  function onDetected(info, detected) {
    if (!settings.autoDetectLang || !info.incoming || !info.recent) return;
    if (!detected || !lang.LANG_NAMES.has(detected) || detected === settings.myLang) return;
    const words = info.text.trim().split(/\s+/).length;
    if (info.text.length < 8 || (words < 3 && info.text.length < 20)) return; // 太短的不算
    const ck = info.chatKey;
    if (!ck || ck !== chat.key) return;
    const hist = detectHistory.get(ck) || [];
    if (hist.length && hist[hist.length - 1].id === info.id) return;
    hist.push({ id: info.id, lang: detected, long: info.text.length >= 40 });
    while (hist.length > 4) hist.shift();
    detectHistory.set(ck, hist);
    const last = hist.slice(-2);
    const confident = (last.length === 2 && last[0].lang === last[1].lang) || hist[hist.length - 1].long;
    if (!confident || detected === chatLang) return;
    const dkey = ck + '|' + detected;
    if (detectDismissed.has(dkey)) return;
    detectDismissed.add(dkey); // 同一个聊天同一种语言只提示一次
    const prev = chatLang;
    if (!chatLangFromContact) {
      setChatLang(detected).then(() => {
        toast(T('检测到对方在用{0}，已自动切换发送语言', langLabel(detected)), null, {
          ms: 10000,
          actions: [{ label: T('撤销'), fn: () => setChatLang(prev) }],
        });
      });
    } else {
      toast(T('对方最近的消息是{0}，当前发送语言是{1}', langLabel(detected), langLabel(prev)), 'warn', {
        ms: 15000,
        actions: [{ label: T('切换到{0}', langLabel(detected)), fn: () => setChatLang(detected) }, { label: T('不用'), fn: () => {} }],
      });
    }
  }

  function requestTranslation(el, info, key, context) {
    const st = { key, status: 'pending' };
    msgState.set(el, st);
    if (resultCache.has(key)) {
      const v = resultCache.get(key);
      st.status = 'done';
      if (v) putLine(el, info, key, makeResultLine(el, info, key, v));
      else removeLine(info);
      return;
    }
    // 启动 8 秒后才出现、并且是最底部的新消息 → 之后弹系统通知
    const fresh = !seenMsgKeys.has(key) && Date.now() - startedAt > 8000 && info.isNewest && info.incoming;
    seenMsgKeys.add(key);
    // 需要调接口时先显示占位
    if (lang.needsReadTranslation(info.text, settings.myLang)) putLine(el, info, key, makeLine(info, T('翻译中…'), 'wa-tr-pending'));
    ipcRenderer
      .invoke('tr:translate', { text: info.text, mode: 'read', context: settings.useContext ? context : undefined })
      .then((res) => {
        const v = res && res.text ? res.text : null;
        resultCache.set(key, v);
        budgetNotice(res);
        if (res && res.lang) onDetected(info, res.lang);
        if (fresh && settings.notifyTranslated !== false && !document.hasFocus()) {
          const who = info.sender || info.chatName || chat.name || '';
          ipcRenderer.invoke('tr:notify', { title: who, body: v || info.text }).catch(() => {});
        }
        if (msgState.get(el) !== st) return;
        st.status = 'done';
        const cur = adapter.getMessageInfo(el) || info;
        if (v) putLine(el, cur, key, makeResultLine(el, cur, key, v));
        else removeLine(cur);
      })
      .catch((err) => {
        if (msgState.get(el) !== st) return;
        st.status = 'error';
        const m = errText(err);
        if (m.includes('EXT_DEAD')) return retire();
        const noKey = m.includes('NO_KEY');
        const line = makeLine(info, noKey ? T('⚠ 未配置 API Key — 点右下角 ⚙ 设置') : T('⚠ 翻译失败：{0}（点击重试）', m.slice(0, 100)), 'wa-tr-error');
        line.addEventListener('click', (e) => {
          e.stopPropagation();
          if (noKey) return ipcRenderer.invoke('tr:open-settings');
          msgState.delete(el);
          line.remove();
          scheduleScan();
        });
        putLine(el, info, key, line);
      });
  }

  function scan() {
    if (!settings || dead) return;
    ensureChat();
    let els = [];
    try {
      els = adapter.getMessageElements();
    } catch (_) {}
    const vh = window.innerHeight;
    const infos = [];
    const textEls = new Set();
    for (let idx = 0; idx < els.length; idx++) {
      let info = null;
      try {
        info = adapter.getMessageInfo(els[idx]);
      } catch (_) {}
      if (info && info.text) {
        textEls.add(els[idx]);
        info.el = els[idx];
        info.isNewest = idx >= els.length - 3; // 屏幕上最新的几条
        info.recent = idx >= els.length - 6;
        infos.push(info);
      }
    }
    const noText = els.filter((x) => !textEls.has(x));
    try {
      scanVoice(noText);
    } catch (_) {}
    try {
      scanImages(els);
    } catch (_) {}
    lastInfos = infos.slice(-8).map((x) => ({ role: x.incoming ? 'them' : 'me', text: x.text }));
    for (let n = 0; n < infos.length; n++) {
      const info = infos[n];
      const el = info.el;
      info.chatKey = chat.key;
      info.chatName = chat.name;
      const context = infos.slice(Math.max(0, n - 5), n).map((x) => ({ role: x.incoming ? 'them' : 'me', text: x.text }));
      messageListeners.forEach((fn) => {
        try {
          fn(info, el);
        } catch (_) {}
      });

      if (!settings.autoTranslateIncoming) continue;
      if (!info.incoming && !settings.showOwnTranslation) continue;
      const key = (info.id || '') + '::' + info.text;
      const st = msgState.get(el);
      if (st && st.key === key) {
        // 页面重新渲染把翻译行冲掉了 → 从缓存补回来
        if (st.status === 'done' && resultCache.get(key) && !findLine(info)) putLine(el, info, key, makeResultLine(el, info, key, resultCache.get(key)));
        continue;
      }
      // 只翻译屏幕附近的消息，省钱也不会被限流
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.bottom < -800 || r.top > vh + 800) continue;
      requestTranslation(el, info, key, context);
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 250);
  }

  function resetTranslations() {
    document.querySelectorAll('.wa-tr-line').forEach((x) => x.remove());
    msgState = new WeakMap();
    resultCache = new Map();
    scheduleScan();
  }

  // ---------------- 写入输入框 / 发送 ----------------
  function composerText(box) {
    return readRichText(box, adapter.composerSkip);
  }

  // 把译文写进输入框。不同网页编辑器（WhatsApp 新版用 Lexical）对写入方式的要求不同，
  // 这里依次尝试几种方法，每一步都确认输入框里真的变成了译文才算成功。
  async function replaceComposer(box, text) {
    const live = () => (box && box.isConnected ? box : adapter.getComposer() || box);
    const done = () => lang.looseEqual(composerText(live()), text);
    const prepare = async () => {
      const b = live();
      b.focus();
      selectAllIn(b);
      await sleepMs(40); // 让编辑器先同步到“已全选”的状态
      return b;
    };
    const tried = [];
    const strategies = [
      // 1. 宿主提供的方式（桌面版：Chromium 原生输入；插件：浏览器编辑命令）
      ['host', async () => {
        const b = await prepare();
        // 原生“全选 + 输入”作用在当前焦点元素上：焦点不在输入框里就跳过，免得写到搜索框等别的地方
        const ae = document.activeElement;
        if (!ae || !(ae === b || b.contains(ae) || ae.contains(b))) throw new Error('focus-not-in-composer');
        await ipcRenderer.invoke('tr:compose-insert', { text });
      }],
      // 2. 模拟粘贴：Lexical / Telegram 都会处理 paste 事件
      ['paste', async () => {
        const b = await prepare();
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        b.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }],
      // 3. beforeinput 事件：现代编辑器的标准输入入口
      ['beforeinput', async () => {
        const b = await prepare();
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        b.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertReplacementText', data: text, dataTransfer: dt, bubbles: true, cancelable: true, composed: true }));
      }],
      // 4. 先删除再插入
      ['delete+insert', async () => {
        await prepare();
        document.execCommand('delete');
        await sleepMs(30);
        document.execCommand('insertText', false, text);
      }],
    ];
    for (const [name, run] of strategies) {
      if (done()) break;
      tried.push(name);
      try {
        await run();
      } catch (_) {}
      if (await waitFor(done, name === 'host' ? 1200 : 700)) {
        lastTranslated = { text, at: Date.now() };
        if (name !== 'host') console.info('[translator] fallback insert: ' + name);
        return;
      }
    }
    if (done()) {
      lastTranslated = { text, at: Date.now() };
      return;
    }
    const b = live();
    const diag = {
      tried,
      tag: b && b.tagName,
      lexical: !!(b && b.hasAttribute && b.hasAttribute('data-lexical-editor')),
      inFooter: !!(b && b.closest && b.closest('footer')),
      focused: document.activeElement === b,
      now: composerText(b).slice(0, 30),
    };
    console.warn('[translator] insert failed', diag, b);
    const e = new Error(T('译文没能写入输入框（诊断：{0}）', JSON.stringify(diag)));
    e.copy = text;
    throw e;
  }

  async function sendNow(box) {
    const liveBox = () => (box && box.isConnected ? box : adapter.getComposer());
    const sent = composerText(box);
    const isCleared = () => {
      const b = liveBox();
      return !b || !composerText(b);
    };
    bypassUntil = Date.now() + 1500;
    box.focus();
    await ipcRenderer.invoke('tr:compose-enter', { sendKey: sendKeyMode() });
    let cleared = await waitFor(isCleared, 1500);
    // 发送键没生效时再点一次发送按钮；输入框内容已经变了（比如用户又打字了）就不点，避免重复发送
    if (!cleared && adapter.findSendButton && lang.looseEqual(composerText(liveBox()), sent)) {
      const btn = adapter.findSendButton(box);
      if (btn) {
        bypassUntil = Date.now() + 1500;
        btn.click();
        cleared = await waitFor(isCleared, 1500);
      }
    }
    bypassUntil = 0; // 发完就关掉“放行”窗口，用户接着按回车还是会翻译
    if (!cleared) toast(T('译文已填入输入框，但没能自动发送，请手动按发送'), 'warn', { ms: 5000 });
    return cleared;
  }

  let busyToast = null;
  async function translateDraft(box, andSend) {
    if (!box) box = adapter.getComposer() || lastComposer;
    if (!box || !box.isConnected) return toast(T('没找到输入框'), 'warn');
    const text = composerText(box);
    if (!text) return;
    if (busy) return;
    busy = true;
    busyToast = toast(T('翻译中…'), null, { ms: 0 });
    let translated = null;
    try {
      ensureChat();
      await chatLangReady;
      const target = chatLang;
      const res = await ipcRenderer.invoke('tr:translate', {
        text,
        mode: 'send',
        targetLang: target,
        tone: chatTone,
        context: settings.useContext ? lastInfos.slice(-6) : undefined,
      });
      if (!box.isConnected) throw new Error(T('输入框已关闭，已取消'));
      if (!lang.looseEqual(composerText(box), text)) throw new Error(T('翻译期间草稿被修改，已取消发送（请重新按回车）'));
      translated = res.text;
      budgetNotice(res);
      if (andSend && !res.passed && (settings.previewBeforeSend || res.forcePreview)) {
        if (busyToast) busyToast.remove();
        busyToast = null;
        const final = await showPreview(text, res.text, target, res.forcePreview);
        if (final === null) return null; // 取消
        translated = final;
        if (!box.isConnected) box = adapter.getComposer();
        await replaceComposer(box, final);
        await sendNow(box);
        return translated;
      }
      if (!res.passed) await replaceComposer(box, res.text);
      else lastTranslated = { text, at: Date.now() };
      if (andSend) await sendNow(box);
    } catch (err) {
      const m = errText(err);
      if (m.includes('NO_KEY')) {
        toast(T('未配置 API Key，请点右下角 ⚙ 设置。消息没有发送。'), 'error');
      } else if (err.copy) {
        let copied = false;
        try {
          await navigator.clipboard.writeText(err.copy);
          copied = true;
        } catch (_) {}
        toast(
          m + (copied ? T('\n译文已复制到剪贴板：在输入框里全选后粘贴（⌘/Ctrl+V）再发送即可。') : T('\n消息没有发送，草稿已保留。')),
          'error',
          { copy: err.copy, ms: 15000 }
        );
      } else {
        toast(T('翻译失败：') + m + (andSend ? T('\n消息没有发送，草稿已保留。') : ''), 'error', { ms: 8000 });
      }
    } finally {
      busy = false;
      if (busyToast) busyToast.remove();
      busyToast = null;
    }
    return translated;
  }

  // 发送前预览：显示译文（可修改）+ 译回中文的意思，回车发送、Esc 取消
  function showPreview(original, translated, target, forced) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.id = 'trx-preview';
      const why = forced === 'context-instruction' ? T('对方最近的消息里有疑似“给 AI 下指令”的内容，请核对译文再发') : forced === 'length' ? T('译文长度和原文差得较多，请核对后再发') : '';
      wrap.innerHTML =
        '<div class="trx-pv-h">' + T('确认译文') + ' · ' + escapeHtml(langLabel(target)) + ' · ' + escapeHtml(T(tones[chatTone] || '')) + '</div>' +
        (why ? '<div class="trx-pv-orig" style="color:#8a5a00">⚠ ' + escapeHtml(why) + '</div>' : '') +
        '<div class="trx-pv-orig"></div>' +
        '<textarea class="trx-pv-text" rows="3"></textarea>' +
        '<div class="trx-pv-back">' + T('意思：核对中…') + '</div>' +
        '<div class="trx-pv-btns"><span>' + T('回车发送 · Shift+回车换行 · Esc 取消') + '</span><button class="trx-pv-cancel">' + T('取消') + '</button><button class="trx-pv-send">' + T('发送') + '</button></div>';
      wrap.querySelector('.trx-pv-orig').textContent = T('原文：') + original;
      const ta = wrap.querySelector('textarea');
      ta.value = translated;
      ta.rows = Math.min(8, Math.max(2, translated.split('\n').length + 1));
      document.body.appendChild(wrap);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const back = wrap.querySelector('.trx-pv-back');
      let edited = false;
      ipcRenderer
        .invoke('tr:translate', { text: translated, mode: 'back' })
        .then((r) => {
          if (!edited) back.textContent = T('意思：') + ((r && r.text) || translated);
        })
        .catch((e) => (back.textContent = T('意思：（核对失败：{0}）', errText(e).slice(0, 60))));
      ta.addEventListener('input', () => {
        edited = true;
        back.textContent = T('意思：（已手动修改，未重新核对）');
      });
      const finish = (v) => {
        wrap.remove();
        resolve(v);
      };
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(null);
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          const v = ta.value.trim();
          finish(v || null);
        }
      });
      wrap.querySelector('.trx-pv-cancel').onclick = () => finish(null);
      wrap.querySelector('.trx-pv-send').onclick = () => finish(ta.value.trim() || null);
    });
  }

  function shouldIntercept(box, text) {
    if (!settings.autoTranslateSend) return false;
    if (Date.now() < bypassUntil) return false;
    if (!text) return false;
    // 已经是翻译好的内容（60 秒内）→ 原生发送
    if (isLastTranslated(text)) return false;
    // 不需要翻译的（纯表情、外语、中文发中文）→ 原生发送，不走网络
    if (lang.outgoingPassReason(text, settings.myLang, chatLang)) return false;
    return true;
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  // 没拦截、让聊天软件自己发送时，把原因记到控制台，方便排查“为什么发出去的是原文”
  function passThrough(reason, text, extra) {
    try {
      const info = { reason, text: String(text || '').slice(0, 30), autoTranslateSend: settings && settings.autoTranslateSend, chatLang, myLang: settings && settings.myLang, sendKey: sendKeyMode(), chat: chat.name, ...(extra || {}) };
      console.info('[translator] 放行（未翻译）:', JSON.stringify(info));
      // 桌面版写到本机日志文件（设置 → 本机数据里能找到），方便用户反馈
      ipcRenderer.invoke('tr:log', { kind: 'pass-through', ...info }).catch(() => {});
    } catch (_) {}
  }
  function interceptReason(box, text) {
    if (!settings.autoTranslateSend) return 'auto-translate-off';
    if (Date.now() < bypassUntil) return 'bypass-window';
    if (!text) return 'empty-text';
    if (isLastTranslated(text)) return 'already-translated';
    const r = lang.outgoingPassReason(text, settings.myLang, chatLang);
    if (r) return 'pass:' + r;
    return null;
  }

  let swallowKeyup = false;
  function installIntercept() {
    winOn(
      'keydown',
      (e) => {
        // 常用语面板开着时，回车 / 方向键由它处理
        if (quickFor && quickBox && quickBox.style.display === 'block' && adapter.composerFrom(e.target) === quickFor && /^(Enter|ArrowUp|ArrowDown|Escape|Tab)$/.test(e.key)) return;
        if (e.altKey && e.code === 'KeyT') {
          block(e);
          translateDraft(null, false);
          return;
        }
        if (e.altKey && e.code === 'KeyV' && adapter.voiceSend) {
          block(e);
          sendAsVoice(null);
          return;
        }
        const kind = keyKind(e);
        if (!kind || kind === 'newline') {
          if (e.key === 'Enter' && !e.shiftKey && adapter.composerFrom(e.target)) passThrough(kind === 'newline' ? 'newline-in-ctrlEnter-mode' : e.isComposing ? 'ime-composing' : 'modifier-key', composerText(adapter.composerFrom(e.target)), { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, keyCode: e.keyCode });
          return;
        }
        const box = adapter.composerFrom(e.target);
        if (!box) {
          if (e.key === 'Enter' && e.target && e.target.closest && e.target.closest('[contenteditable="true"]')) passThrough('not-composer', '', { tag: e.target.tagName, label: e.target.getAttribute && e.target.getAttribute('aria-label') });
          return;
        }
        if (kind === 'raw') {
          // 不翻译，直接发原文（回车模式：Ctrl/⌘+Enter；Ctrl+回车模式：Alt+Enter）
          if (busy || !composerText(box)) return;
          passThrough('raw-shortcut', composerText(box));
          block(e);
          swallowKeyup = true;
          sendNow(box).then((ok) => ok && toast(T('已发送原文（未翻译）')));
          return;
        }
        if (Date.now() < bypassUntil) {
          passThrough('bypass-window', composerText(box));
          return;
        }
        if (busy) {
          // 正在翻译：吞掉回车，防止原文被发出去
          block(e);
          swallowKeyup = true;
          return;
        }
        ensureChat();
        const text = composerText(box);
        if (!shouldIntercept(box, text)) {
          passThrough(interceptReason(box, text) || 'unknown', text);
          return;
        }
        block(e);
        swallowKeyup = true;
        ipcRenderer.invoke('tr:log', { kind: 'intercept', via: 'enter', text: text.slice(0, 30), chatLang }).catch(() => {});
        translateDraft(box, true);
      }
    );
    winOn(
      'keyup',
      (e) => {
        if (e.key === 'Enter' && swallowKeyup) {
          block(e);
          swallowKeyup = false;
        }
      }
    );
    winOn(
      'click',
      (e) => {
        if (ownClick || !e.target || !e.target.closest) return;
        const btn = adapter.sendButtonFrom
          ? adapter.sendButtonFrom(e.target)
          : adapter.sendButtonSelector
            ? e.target.closest(adapter.sendButtonSelector)
            : null;
        if (!btn || btn.closest('#trx-bar')) return;
        if (Date.now() < bypassUntil) {
          passThrough('bypass-window(click)', '');
          return;
        }
        const box = adapter.composerForButton ? adapter.composerForButton(btn) : adapter.getComposer();
        if (!box) {
          passThrough('click:no-composer', '');
          return;
        }
        if (busy) return block(e);
        ensureChat();
        const text = composerText(box);
        if (!shouldIntercept(box, text)) {
          passThrough('click:' + (interceptReason(box, text) || 'unknown'), text);
          return;
        }
        block(e);
        translateDraft(box, true);
      }
    );
    docOn(
      'focusin',
      (e) => {
        const box = adapter.composerFrom(e.target);
        if (box) lastComposer = box;
      },
      true
    );
    installQuickPhrases();
  }

  // ---------------- 常用语：输入框里打 / 弹出 ----------------
  let quickBox = null;
  let quickFor = null; // 当前面板对应的输入框
  let quickIndex = 0;
  function quickPhrases() {
    return (settings && settings.quickPhraseList) || [];
  }
  function hideQuick() {
    if (quickBox) quickBox.style.display = 'none';
    quickFor = null;
  }
  function renderQuick(box, filter) {
    const all = quickPhrases();
    if (!all.length) return hideQuick();
    const f = String(filter || '').trim().toLowerCase();
    const items = f ? all.filter((p) => p.toLowerCase().includes(f)) : all;
    if (!items.length) return hideQuick();
    if (!quickBox) {
      quickBox = document.createElement('div');
      quickBox.id = 'trx-quick';
      document.body.appendChild(quickBox);
    }
    quickBox.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'trx-qh';
    h.textContent = T('常用语 · ↑↓ 选择，回车或点击填入并翻译，Esc 关闭 · 在设置里编辑');
    quickBox.appendChild(h);
    quickIndex = Math.min(quickIndex, items.length - 1);
    items.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'trx-q' + (i === quickIndex ? ' trx-cur' : '');
      d.textContent = p;
      d.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 不让输入框失焦
        e.stopPropagation();
      });
      d.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pickQuick(box, p);
      });
      quickBox.appendChild(d);
    });
    quickBox.items = items;
    const r = box.getBoundingClientRect();
    quickBox.style.display = 'block';
    quickBox.style.left = Math.max(8, Math.min(r.left, window.innerWidth - quickBox.offsetWidth - 8)) + 'px';
    quickBox.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
    quickFor = box;
  }
  async function pickQuick(box, phrase) {
    hideQuick();
    try {
      await replaceComposer(box, phrase);
      lastTranslated = null; // 这是原文，接下来要翻译
      await translateDraft(box, false);
    } catch (err) {
      toast(errText(err), 'error', { copy: phrase });
    }
  }
  function installQuickPhrases() {
    // 输入内容变化：以 / 开头就弹常用语
    docOn(
      'input',
      (e) => {
        const box = adapter.composerFrom(e.target);
        if (!box) return;
        const text = composerText(box);
        if (/^\/(?!\/)/.test(text) && text.length <= 40 && quickPhrases().length) {
          quickIndex = quickFor === box ? quickIndex : 0;
          renderQuick(box, text.slice(1));
        } else if (quickFor) hideQuick();
      },
      true
    );
    docOn(
      'keydown',
      (e) => {
        if (!quickFor || !quickBox || quickBox.style.display !== 'block') return;
        if (adapter.composerFrom(e.target) !== quickFor) return;
        const items = quickBox.items || [];
        if (e.key === 'Escape') {
          block(e);
          hideQuick();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          block(e);
          quickIndex = (quickIndex + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
          renderQuick(quickFor, composerText(quickFor).slice(1));
        } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
          block(e);
          swallowKeyup = true;
          if (items[quickIndex]) pickQuick(quickFor, items[quickIndex]);
        } else if (e.key === 'Tab') {
          block(e);
          if (items[quickIndex]) pickQuick(quickFor, items[quickIndex]);
        }
      },
      true
    );
    docOn('focusout', () => setTimeout(() => quickFor && document.activeElement !== quickFor && hideQuick(), 150), true);
    docOn('click', (e) => quickBox && !quickBox.contains(e.target) && hideQuick(), true);
  }

  // ---------------- 语音 ----------------
  // 对方的语音消息：点“转文字”（或自己点播放）→ 主环境脚本读出音频 → 语音识别 → 翻译
  const voiceState = new Map(); // 消息 id → { status: wait|busy|done|error, transcript, text, err }
  let voiceWant = null; // 正在等音频数据的那条语音 { id, el, vinfo, at }
  let micFab = null;
  let voiceSendFab = null;

  function voiceOn() {
    return !!settings && settings.voiceTranslate !== false && !!adapter.getVoiceInfo;
  }
  function syncVoiceAttr() {
    const root = document.documentElement;
    if (voiceOn()) root.setAttribute('data-trx-voice-on', '');
    else root.removeAttribute('data-trx-voice-on');
    if (micFab) micFab.style.display = settings && settings.voiceTranslate === false ? 'none' : '';
  }
  function needSttKey() {
    if (settings.hasSttKey) return false;
    toast(T('语音转文字要先在设置里填“语音识别”的 Key（推荐 Groq，很便宜；或用 OpenAI）'), 'warn', {
      ms: 10000,
      actions: [{ label: T('去设置'), fn: () => ipcRenderer.invoke('tr:open-settings') }],
    });
    return true;
  }
  function voiceErrText(err) {
    const m = errText(err);
    if (m.includes('NO_STT_KEY')) return T('没有填语音识别的 Key（设置 → 语音）');
    if (m.includes('NO_KEY')) return T('没有填翻译的 API Key');
    return m.slice(0, 120);
  }

  function renderVoice(el, vinfo) {
    const st = voiceState.get(vinfo.id) || { status: 'idle' };
    const key = 'voice|' + vinfo.id + '|' + st.status + '|' + (st.transcript || '') + '|' + (st.text || '') + '|' + (st.err || '');
    const cur = findLine(vinfo);
    if (cur && cur.dataset.key === key) return;
    const line = makeLine(vinfo, '', 'wa-tr-voice');
    if (st.status === 'idle') {
      line.classList.add('wa-tr-voice-btn');
      line.textContent = T('🎤 转文字并翻译');
      line.title = T('识别这条语音说了什么，并翻译成') + langLabel(settings.myLang);
      line.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        requestVoice(el, vinfo, true);
      });
    } else if (st.status === 'wait' || st.status === 'busy') {
      line.classList.add('wa-tr-pending');
      line.textContent = st.status === 'wait' ? T('🎤 读取语音…') : T('🎤 识别中…');
    } else if (st.status === 'error') {
      line.classList.add('wa-tr-error');
      line.textContent = T('⚠ 语音转文字失败：{0}（点击重试）', st.err);
      line.addEventListener('click', (e) => {
        e.stopPropagation();
        voiceState.delete(vinfo.id);
        requestVoice(el, vinfo, true);
      });
    } else {
      const t = document.createElement('div');
      t.className = 'trx-vt';
      t.textContent = '🎤 ' + (st.transcript || T('（没听到说话内容）'));
      line.appendChild(t);
      if (st.text) {
        const tr = document.createElement('div');
        tr.textContent = st.text;
        line.appendChild(tr);
      }
    }
    putLine(el, vinfo, key, line);
  }

  function scanVoice(els) {
    if (!voiceOn()) return;
    for (const el of els) {
      let vinfo = null;
      try {
        vinfo = adapter.getVoiceInfo(el);
      } catch (_) {}
      if (!vinfo || !vinfo.id) continue;
      if (!vinfo.incoming && !settings.showOwnTranslation && !voiceState.has(vinfo.id)) continue;
      renderVoice(el, vinfo);
    }
  }

  function voiceTarget(target) {
    if (!voiceOn() || !target || !target.closest) return null;
    let els = [];
    try {
      els = adapter.getMessageElements();
    } catch (_) {}
    const el = els.find((x) => x.contains(target));
    if (!el) return null;
    const vinfo = adapter.getVoiceInfo(el);
    if (!vinfo || !vinfo.playBtn || !vinfo.playBtn.contains(target)) return null;
    return { el, vinfo };
  }

  function requestVoice(el, vinfo, silent) {
    if (needSttKey()) return;
    const id = vinfo.id;
    voiceState.set(id, { status: 'wait' });
    renderVoice(el, vinfo);
    voiceWant = { id, el, vinfo, at: Date.now() };
    syncVoiceAttr();
    const root = document.documentElement;
    if (silent) root.setAttribute('data-trx-voice-silent', '');
    try {
      vinfo.playBtn.click();
    } catch (_) {}
    setTimeout(() => root.removeAttribute('data-trx-voice-silent'), 1500);
    // 第一次播放可能要先下载，多等一会
    setTimeout(() => {
      const st = voiceState.get(id);
      if (st && st.status === 'wait') {
        voiceState.set(id, { status: 'error', err: T('没读到语音（可以先点一下播放键，等它能播放了再试）') });
        if (voiceWant && voiceWant.id === id) voiceWant = null;
        scheduleScan();
      }
    }, 20000);
  }

  function onVoiceData(payload) {
    const w = voiceWant;
    if (!w || Date.now() - w.at > 25000) return;
    voiceWant = null;
    const id = w.id;
    const prev = voiceState.get(id);
    if (prev && prev.status === 'done') return;
    if (payload.error) {
      voiceState.set(id, { status: 'error', err: payload.error });
      scheduleScan();
      return;
    }
    voiceState.set(id, { status: 'busy' });
    scheduleScan();
    ipcRenderer
      .invoke('tr:transcribe', { audio: payload.b64, mime: payload.mime, purpose: 'read', context: settings.useContext ? lastInfos.slice(-6) : undefined })
      .then((res) => {
        voiceState.set(id, { status: 'done', transcript: (res && res.transcript) || '', text: (res && res.text) || '' });
        if (res && res.lang && res.transcript)
          onDetected({ id: 'voice:' + id, incoming: w.vinfo.incoming, recent: true, text: res.transcript, chatKey: chat.key }, res.lang);
        scheduleScan();
      })
      .catch((err) => {
        voiceState.set(id, { status: 'error', err: voiceErrText(err) });
        scheduleScan();
      });
  }

  function installVoice() {
    docOn('trx-voice-data', (e) => {
      let payload = null;
      try {
        payload = JSON.parse(e.detail);
      } catch (_) {}
      if (payload) onVoiceData(payload);
    });
    // 自己点了语音的播放键：边听边转文字
    docOn(
      'click',
      (e) => {
        if (!settings || settings.voiceAutoOnPlay === false || !settings.hasSttKey) return;
        const hit = voiceTarget(e.target);
        if (!hit) return;
        const st = voiceState.get(hit.vinfo.id);
        if (st && (st.status === 'done' || st.status === 'busy')) return;
        voiceWant = { id: hit.vinfo.id, el: hit.el, vinfo: hit.vinfo, at: Date.now() };
      },
      true
    );
  }

  // 说中文：录音 → 识别 → 填进输入框 → 翻译成对方语言（不自动发送）
  let rec = null;
  async function toggleDictation() {
    if (rec) return stopDictation();
    if (needSttKey()) return;
    const box = adapter.getComposer() || lastComposer;
    if (!box) return toast(T('请先打开一个聊天'), 'warn');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      return toast(T('没能打开麦克风：{0}\n请在系统设置里允许使用麦克风。', (err && (err.message || err.name)) || err), 'error', { ms: 8000 });
    }
    const type = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    let mr;
    try {
      mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      return toast(T('录音失败：') + errText(err), 'error');
    }
    const r = { mr, stream, chunks: [], t0: Date.now(), box };
    rec = r;
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size) r.chunks.push(e.data);
    };
    mr.onstop = () => finishDictation(r);
    mr.start(250);
    if (micFab) {
      micFab.textContent = '■';
      micFab.style.background = '#e53935';
      micFab.title = T('正在录音，点击结束');
    }
    r.toast = toast(T('🎤 正在听…说完再点一下红色按钮（最长 60 秒）'), null, { ms: 0, actions: [{ label: T('取消'), fn: () => stopDictation(true) }] });
    r.timer = setTimeout(() => stopDictation(), 60000);
  }

  function stopDictation(cancel) {
    const r = rec;
    if (!r) return;
    r.cancel = !!cancel;
    clearTimeout(r.timer);
    try {
      r.mr.stop();
    } catch (_) {
      finishDictation(r);
    }
  }

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function finishDictation(r) {
    if (r.finished) return;
    r.finished = true;
    r.stream.getTracks().forEach((t) => t.stop());
    if (rec === r) rec = null;
    if (r.toast) r.toast.remove();
    if (micFab) {
      micFab.textContent = '🎤';
      micFab.style.background = '#1e88e5';
      micFab.title = T('说中文：点一下开始录音，再点一下结束，自动翻译成对方语言');
    }
    if (r.cancel) return;
    const blob = new Blob(r.chunks, { type: (r.mr.mimeType || 'audio/webm').split(';')[0] });
    if (Date.now() - r.t0 < 700 || blob.size < 800) return toast(T('录音太短了，请再说一次'), 'warn');
    const t = toast(T('🎤 识别中…'), null, { ms: 0 });
    try {
      const res = await ipcRenderer.invoke('tr:transcribe', { audio: await blobToB64(blob), mime: blob.type, purpose: 'dictate' });
      t.remove();
      const said = String((res && res.transcript) || '').trim();
      if (!said) return toast(T('没听清，请再说一次'), 'warn');
      const box = r.box && r.box.isConnected ? r.box : adapter.getComposer();
      if (!box) {
        navigator.clipboard.writeText(said).catch(() => {});
        return toast(T('识别结果：{0}\n（没找到输入框，已复制）', said), 'warn', { ms: 10000 });
      }
      const existing = composerText(box);
      const joined = existing ? existing + (/[　-鿿＀-￯]$/.test(existing) ? '' : ' ') + said : said;
      await replaceComposer(box, joined);
      lastTranslated = null; // 这还是原文，按回车时要翻译
      if (settings.voiceAutoTranslate !== false) await translateDraft(box, false);
      else toast(T('🎤 已填入：') + said);
    } catch (err) {
      t.remove();
      toast(T('语音识别失败：') + voiceErrText(err), 'error', { ms: 8000 });
    }
  }

  // ---------------- 发语音条：文字 → 翻译 → 合成语音 → 当作录音发出去 ----------------
  // 真实的指针事件序列（聊天网页的录音键只认 pointerdown/up，不认 click()）
  let ownClick = false; // 我们自己按录音 / 发送键时，不要被上面的发送拦截逻辑拦住
  function pressButton(el) {
    ownClick = true;
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    const fire = (type, extra) => el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...base, ...extra }) : new MouseEvent(type, { ...base, ...extra }));
    fire('pointerdown', { buttons: 1 });
    fire('mousedown', { buttons: 1 });
    return sleepMs(60)
      .then(() => {
        fire('pointerup', { buttons: 0 });
        fire('mouseup', { buttons: 0 });
        fire('click', { buttons: 0 });
      })
      .finally(() => {
        ownClick = false;
      });
  }
  // 清空输入框：依次试几种方法（WhatsApp 的 Lexical 编辑器只认“全选 + beforeinput 删除”，execCommand 不管用）
  async function clearComposer(box) {
    const live = () => (box && box.isConnected ? box : adapter.getComposer() || box);
    const empty = () => !composerText(live());
    if (empty()) return true;
    const prep = async () => {
      const b = live();
      b.focus();
      selectAllIn(b);
      await sleepMs(80); // 等编辑器同步到“已全选”
      return b;
    };
    const strategies = [
      async () => {
        const b = await prep();
        b.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
      },
      async () => {
        await prep();
        await ipcRenderer.invoke('tr:compose-insert', { text: '' });
      },
      async () => {
        await prep();
        document.execCommand('delete');
      },
      async () => {
        const b = await prep();
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true }));
      },
    ];
    for (const run of strategies) {
      try {
        await run();
      } catch (_) {}
      if (await waitFor(empty, 600)) return true;
    }
    return empty();
  }
  function outgoingVoiceIds() {
    const ids = new Set();
    if (!adapter.getVoiceInfo) return ids;
    let els = [];
    try {
      els = adapter.getMessageElements();
    } catch (_) {}
    for (const el of els) {
      try {
        const v = adapter.getVoiceInfo(el);
        if (v && v.id && !v.incoming) ids.add(v.id);
      } catch (_) {}
    }
    return ids;
  }
  const ttsAudioCache = new Map(); // text|voice|speed → { b64, mime }
  async function getTts(text, voice, speed, lang) {
    const key = [text, voice, speed, lang].join('|');
    if (ttsAudioCache.has(key)) return ttsAudioCache.get(key);
    const r = await ipcRenderer.invoke('tr:tts', { text, voice, speed, lang });
    if (!r || !r.b64) throw new Error(T('语音合成没有返回音频'));
    if (r.voiceFallback) toast(T('你选的声音在 ElevenLabs 账号里不可用，这次用了默认声音；请到设置里重新拉取声音列表'), 'warn', { ms: 8000 });
    ttsAudioCache.set(key, r);
    while (ttsAudioCache.size > 10) ttsAudioCache.delete(ttsAudioCache.keys().next().value);
    return r;
  }
  function ttsErrText(err) {
    const m = errText(err);
    if (m.includes('NO_TTS_KEY')) return T('没有填语音合成的 Key（设置 → 发语音，用 OpenAI 的 Key）');
    if (m.includes('NO_KEY')) return T('没有填翻译的 API Key');
    return m.slice(0, 160);
  }

  // 预览：译文可改、选声音、试听，确认后再发
  // retranslate(targetLang) → 译文；预览框里换语言时调用
  function showVoicePreview(original, translated, target, retranslate) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.id = 'trx-vs';
      const langOpts = lang.LANGUAGES.map((l) => '<option value="' + escapeHtml(l.name) + '"' + (l.name === target ? ' selected' : '') + '>' + escapeHtml(langLabel(l.name)) + '</option>').join('');
      const voices = (settings.ttsVoices || []).map((v) => '<option value="' + escapeHtml(v.id) + '"' + (v.id === settings.ttsVoice ? ' selected' : '') + '>' + escapeHtml(T(v.label)) + '</option>').join('');
      const speeds = (settings.ttsEngine === 'elevenlabs' ? [0.85, 0.95, 1, 1.1, 1.2] : [0.85, 0.95, 1, 1.05, 1.15, 1.25]).map((x) => '<option value="' + x + '"' + (Math.abs(x - (parseFloat(settings.ttsSpeed) || 1)) < 0.03 ? ' selected' : '') + '>' + (x === 1 ? T('正常语速') : T('语速 {0}', x)) + '</option>').join('');
      wrap.innerHTML =
        '<div class="trx-pv-h" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span>🔊 ' + T('发语音条') + '</span><select class="trx-vs-lang" title="' + T('这条语音用哪种语言说') + '">' + langOpts + '</select><span class="trx-vs-status trx-vs-langstatus"></span></div>' +
        '<div class="trx-pv-orig"></div>' +
        '<textarea class="trx-vs-text" rows="3"></textarea>' +
        '<div class="trx-vs-row"><select class="trx-vs-voice">' + voices + '</select><select class="trx-vs-speed">' + speeds + '</select><span class="trx-vs-status">' + T('可以先试听，确认后发送；对方收到的是普通语音条') + '</span></div>' +
        '<div class="trx-vs-row"><button class="trx-vs-play">▶ ' + T('试听') + '</button><span class="trx-vs-status"></span><button class="trx-vs-cancel">' + T('取消') + '</button><button class="trx-vs-send">' + T('发送语音条') + '</button></div>';
      wrap.querySelector('.trx-pv-orig').textContent = T('原文：') + original;
      const ta = wrap.querySelector('textarea');
      ta.value = translated;
      ta.rows = Math.min(8, Math.max(2, translated.split('\n').length + 1));
      document.body.appendChild(wrap);
      ta.focus();
      const sel = () => ({ text: ta.value.trim(), voice: wrap.querySelector('.trx-vs-voice').value, speed: wrap.querySelector('.trx-vs-speed').value, target: curTarget });
      const status = wrap.querySelector('.trx-vs-row + .trx-vs-row .trx-vs-status');
      const langStatus = wrap.querySelector('.trx-vs-langstatus');
      let player = null;
      let curTarget = target;
      // 换语言：重新翻译一遍再填进去
      wrap.querySelector('.trx-vs-lang').addEventListener('change', async (e) => {
        const l = e.target.value;
        if (!retranslate || l === curTarget) return;
        curTarget = l;
        langStatus.textContent = T('翻译中…');
        ta.disabled = true;
        try {
          const t = await retranslate(l);
          if (curTarget !== l) return;
          ta.value = t;
          ta.rows = Math.min(8, Math.max(2, t.split('\n').length + 1));
          langStatus.textContent = '';
        } catch (err) {
          langStatus.textContent = '✗ ' + errText(err).slice(0, 60);
        } finally {
          ta.disabled = false;
          ta.focus();
        }
      });
      wrap.querySelector('.trx-vs-lang').addEventListener('keydown', (e) => e.stopPropagation());
      const stopPlayer = () => {
        if (player) {
          try {
            player.pause();
          } catch (_) {}
          player = null;
        }
      };
      const finish = (v) => {
        stopPlayer();
        wrap.remove();
        resolve(v);
      };
      wrap.querySelector('.trx-vs-play').onclick = async () => {
        const c = sel();
        if (!c.text) return;
        stopPlayer();
        status.textContent = T('合成中…');
        try {
          const a = await getTts(c.text, c.voice, c.speed, c.target);
          player = new Audio('data:' + (a.mime || 'audio/mpeg') + ';base64,' + a.b64);
          player.onended = () => (status.textContent = '');
          await player.play();
          status.textContent = T('播放中…');
        } catch (err) {
          status.textContent = '✗ ' + ttsErrText(err);
        }
      };
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(null);
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          const c = sel();
          finish(c.text ? c : null);
        }
      });
      ['keyup', 'keypress', 'input'].forEach((t) => ta.addEventListener(t, (e) => e.stopPropagation()));
      wrap.querySelector('.trx-vs-cancel').onclick = () => finish(null);
      wrap.querySelector('.trx-vs-send').onclick = () => {
        const c = sel();
        finish(c.text ? c : null);
      };
    });
  }

  async function sendAsVoice(box) {
    const vs = adapter.voiceSend;
    if (!vs) return toast(T('这个平台暂不支持发语音条'), 'warn');
    if (!settings.hasKey) return toast(T('还没有配置 API Key，点右下角 ⚙ 设置'), 'warn');
    if (!settings.hasTtsKey) {
      return toast(T('发语音要先在设置 → 发语音里填 OpenAI 的 Key'), 'warn', { ms: 10000, actions: [{ label: T('去设置'), fn: () => ipcRenderer.invoke('tr:open-settings') }] });
    }
    if (!box) box = adapter.getComposer() || lastComposer;
    if (!box || !box.isConnected) return toast(T('没找到输入框，请先打开聊天'), 'warn');
    const original = composerText(box);
    if (!original) return toast(T('先在输入框里写要说的话，再点发语音'), 'warn');
    if (busy) return;
    busy = true;
    busyToast = toast(T('翻译中…'), null, { ms: 0 });
    let plan = null;
    let target = chatLang;
    try {
      ensureChat();
      await chatLangReady;
      target = chatLang;
      const res = await ipcRenderer.invoke('tr:translate', { text: original, mode: 'send', targetLang: target, tone: chatTone, context: settings.useContext ? lastInfos.slice(-6) : undefined });
      budgetNotice(res);
      const translated = res.passed ? original : res.text;
      if (busyToast) busyToast.remove();
      busyToast = null;
      busy = false;
      plan = await showVoicePreview(original, translated, target, async (l) => {
        const r = await ipcRenderer.invoke('tr:translate', { text: original, mode: 'send', targetLang: l, tone: chatTone, context: settings.useContext ? lastInfos.slice(-6) : undefined });
        return r.passed ? original : r.text;
      });
    } catch (err) {
      busy = false;
      if (busyToast) busyToast.remove();
      busyToast = null;
      return toast(T('翻译失败：') + errText(err), 'error', { ms: 8000 });
    }
    if (!plan) return;
    await doVoiceSend(box, original, plan);
  }

  async function doVoiceSend(box, original, plan) {
    const vs = adapter.voiceSend;
    const rootEl = document.documentElement;
    if (busy) return;
    busy = true;
    busyToast = toast(T('🔊 合成语音…'), null, { ms: 0 });
    let recording = false;
    const cleanupEvents = [];
    try {
      const audio = await getTts(plan.text, plan.voice, plan.speed, plan.target);
      busyToast.textContent = T('🔊 正在发送语音条…');
      if (!box.isConnected) box = adapter.getComposer();
      if (!(await clearComposer(box))) throw new Error(T('没能清空输入框（发语音前要先清空）'));
      await sleepMs(250);
      const mic = vs.micButton();
      if (!mic) throw new Error(T('没找到录音按钮'));
      const before = outgoingVoiceIds();
      let ended = false;
      let endErr = null;
      let duration = 60;
      const onStarted = (e) => {
        try {
          duration = JSON.parse(e.detail).duration || duration;
        } catch (_) {}
      };
      const onEnded = (e) => {
        ended = true;
        try {
          const d = JSON.parse(e.detail);
          if (d && d.error) endErr = d.error;
        } catch (_) {}
      };
      document.addEventListener('trx-tts-started', onStarted);
      document.addEventListener('trx-tts-ended', onEnded);
      cleanupEvents.push(() => document.removeEventListener('trx-tts-started', onStarted), () => document.removeEventListener('trx-tts-ended', onEnded));
      rootEl.setAttribute('data-trx-tts', '');
      document.dispatchEvent(new CustomEvent('trx-tts-audio', { detail: JSON.stringify({ b64: audio.b64, mime: audio.mime || 'audio/mpeg' }) }));
      await pressButton(mic);
      if (!(await waitFor(() => vs.isRecording(), 4000))) throw new Error(T('没能开始录音（网页可能改版了）'));
      recording = true;
      // 等“录音”（其实是我们的音频）播完
      const ok = await waitFor(() => ended, duration * 1000 + 8000, 100);
      if (endErr) throw new Error(T('音频没能送进录音：') + endErr);
      if (!ok) throw new Error(T('等待录音结束超时'));
      const send = vs.sendButton();
      if (!send) throw new Error(T('没找到录音的发送按钮'));
      await pressButton(send);
      if (!(await waitFor(() => !vs.isRecording(), 5000))) throw new Error(T('点了发送但录音没有结束'));
      recording = false;
      busyToast.remove();
      busyToast = null;
      toast(T('🔊 语音条已发送') + (plan.text.length <= 40 ? '：' + plan.text : ''), null, { ms: 4000 });
      ipcRenderer.invoke('tr:log', { kind: 'voice-send', chars: plan.text.length, voice: plan.voice, lang: plan.target || chatLang }).catch(() => {});
      // 在刚发出去的语音条下面显示原文和译文
      let newId = null;
      await waitFor(() => {
        for (const id of outgoingVoiceIds()) if (!before.has(id)) return (newId = id);
        return false;
      }, 10000, 300);
      if (newId) {
        voiceState.set(newId, { status: 'done', transcript: plan.text, text: original !== plan.text ? original : '' });
        scheduleScan();
      }
    } catch (err) {
      if (busyToast) busyToast.remove();
      busyToast = null;
      if (recording || vs.isRecording()) {
        const c = vs.cancelButton();
        if (c) {
          try {
            await pressButton(c);
          } catch (_) {}
        }
      }
      document.dispatchEvent(new CustomEvent('trx-tts-cancel'));
      ipcRenderer.invoke('tr:log', { kind: 'voice-send-failed', error: errText(err).slice(0, 200) }).catch(() => {});
      // 把原来的草稿放回去，让用户可以改成文字发
      try {
        const b = box && box.isConnected ? box : adapter.getComposer();
        if (b && !composerText(b)) await replaceComposer(b, original);
        lastTranslated = null;
      } catch (_) {}
      toast(T('语音条没有发出去：') + ttsErrText(err) + T('\n草稿已放回输入框。'), 'error', { ms: 10000 });
    } finally {
      rootEl.removeAttribute('data-trx-tts');
      cleanupEvents.forEach((fn) => fn());
      busy = false;
    }
  }

  // ---------------- 图片翻译 ----------------
  // 对方发的截图 / 报价单：点「翻译图片」→ 主环境脚本读出图片 → 识图模型翻译
  const imageState = new Map(); // 消息 id → { status: idle|wait|busy|done|error, text, err }
  const imageWant = new Map(); // 请求 id → { el, iinfo, at }
  function imagesOn() {
    return !!settings && settings.imageTranslate !== false && !!adapter.getImageInfo;
  }
  function putImgLine(el, iinfo, key, line) {
    iinfo.mount.querySelectorAll('.wa-tr-imgline').forEach((x) => x.remove());
    line.classList.add('wa-tr-imgline');
    line.dataset.key = key;
    if (adapter.placeLine) adapter.placeLine(iinfo, line);
    else iinfo.mount.appendChild(line);
  }
  function renderImage(el, iinfo) {
    const st = imageState.get(iinfo.id) || { status: 'idle' };
    const key = 'img|' + iinfo.id + '|' + st.status + '|' + (st.text || '') + '|' + (st.err || '');
    const cur = iinfo.mount.querySelector('.wa-tr-imgline');
    if (cur && cur.dataset.key === key) return;
    let line;
    if (st.status === 'idle') {
      line = makeLine(iinfo, T('🖼 翻译图片'), 'wa-tr-img-btn');
      line.title = T('识别图片里的文字并翻译成') + langLabel(settings.myLang);
      line.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        requestImage(el, iinfo, false);
      });
    } else if (st.status === 'wait' || st.status === 'busy') {
      line = makeLine(iinfo, st.status === 'wait' ? T('🖼 读取图片…') : T('🖼 识别翻译中…'), 'wa-tr-pending');
    } else if (st.status === 'error') {
      line = makeLine(iinfo, T('⚠ 图片翻译失败：{0}（点击重试）', st.err), 'wa-tr-error');
      line.addEventListener('click', (e) => {
        e.stopPropagation();
        imageState.delete(iinfo.id);
        requestImage(el, iinfo, false);
      });
    } else {
      line = makeLine(iinfo, '', '');
      const t = document.createElement('div');
      t.className = 'trx-vt';
      t.textContent = '🖼 ' + (st.text ? T('图片内容') : T('（图片里没有可识别的文字）'));
      line.appendChild(t);
      if (st.text) {
        const tr = document.createElement('div');
        tr.textContent = st.text;
        line.appendChild(tr);
        const fb = document.createElement('div');
        fb.className = 'trx-fb';
        const again = document.createElement('button');
        again.textContent = T('换一种');
        again.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          requestImage(el, iinfo, true);
        };
        const copy = document.createElement('button');
        copy.textContent = T('复制');
        copy.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          navigator.clipboard.writeText(st.text).catch(() => {});
        };
        fb.append(again, copy);
        line.appendChild(fb);
      }
    }
    putImgLine(el, iinfo, key, line);
  }
  function scanImages(els) {
    if (!imagesOn()) return;
    for (const el of els) {
      let iinfo = null;
      try {
        iinfo = adapter.getImageInfo(el);
      } catch (_) {}
      if (!iinfo || !iinfo.id || !iinfo.img) continue;
      if (!iinfo.incoming && !settings.showOwnTranslation && !imageState.has(iinfo.id)) continue;
      renderImage(el, iinfo);
    }
  }
  function requestImage(el, iinfo, force) {
    if (!settings.hasKey) {
      toast(T('还没有配置 API Key，点右下角 ⚙ 设置'), 'warn');
      return;
    }
    if (settings.canVision === false) {
      toast(T('识图需要 OpenAI 或 Gemini 的 Key（文字翻译可以继续用 DeepSeek，只要另外填一个 OpenAI 或 Gemini 的 Key 就行）'), 'warn', { ms: 8000, actions: [{ label: T('去设置'), fn: () => ipcRenderer.invoke('tr:open-settings') }] });
      return;
    }
    const src = iinfo.img.currentSrc || iinfo.img.src;
    if (!src) return;
    const reqId = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    imageState.set(iinfo.id, { status: 'wait' });
    imageWant.set(reqId, { el, iinfo, at: Date.now(), force });
    renderImage(el, iinfo);
    document.dispatchEvent(new CustomEvent('trx-capture-image', { detail: JSON.stringify({ id: reqId, src }) }));
    setTimeout(() => {
      const w = imageWant.get(reqId);
      if (!w) return;
      imageWant.delete(reqId);
      const st = imageState.get(iinfo.id);
      if (st && st.status === 'wait') {
        imageState.set(iinfo.id, { status: 'error', err: T('没读到图片（先点开看一下大图再试）') });
        scheduleScan();
      }
    }, 15000);
  }
  function onImageData(payload) {
    const w = imageWant.get(payload.id);
    if (!w) return;
    imageWant.delete(payload.id);
    const id = w.iinfo.id;
    if (payload.error) {
      imageState.set(id, { status: 'error', err: payload.error });
      scheduleScan();
      return;
    }
    imageState.set(id, { status: 'busy' });
    scheduleScan();
    ipcRenderer
      .invoke('tr:translate-image', { image: payload.b64, mime: payload.mime, force: !!w.force })
      .then((res) => {
        budgetNotice(res);
        imageState.set(id, { status: 'done', text: (res && res.text) || '' });
        scheduleScan();
      })
      .catch((err) => {
        const m = errText(err);
        imageState.set(id, { status: 'error', err: m.includes('NO_KEY') ? T('没有填翻译的 API Key') : m.slice(0, 120) });
        scheduleScan();
      });
  }
  function installImages() {
    docOn('trx-image-data', (e) => {
      let payload = null;
      try {
        payload = JSON.parse(e.detail);
      } catch (_) {}
      if (payload) onImageData(payload);
    });
  }

  // ---------------- 设置 ----------------
  function applySettings(s) {
    i18n.setLang(s.uiLang);
    const uiChanged = settings && s.uiLang !== settings.uiLang;
    const myLangChanged = settings && s.myLang !== settings.myLang;
    const enabledChanged =
      settings &&
      (s.autoTranslateIncoming !== settings.autoTranslateIncoming || s.showOwnTranslation !== settings.showOwnTranslation || s.glossary !== settings.glossary);
    if (settings && s.imageTranslate !== settings.imageTranslate && s.imageTranslate === false) document.querySelectorAll('.wa-tr-imgline').forEach((x) => x.remove());
    const keyAdded = settings && !settings.hasKey && s.hasKey;
    settings = s;
    if (!chatLangFromContact) chatLang = s.defaultTheirLang;
    updateLangFab();
    updateTrFab();
    if (isOpen(langPanel)) renderLangPanel();
    syncVoiceAttr();
    if (voiceSendFab) voiceSendFab.style.display = s.voiceSend === false ? 'none' : '';
    if (uiChanged) {
      if (trFab) trFab.textContent = T('译');
      if (micFab && !rec) micFab.title = T('说中文：点一下开始录音，再点一下结束，自动翻译成对方语言');
      const sf = document.getElementById('trx-settings-fab');
      if (sf) sf.title = T('设置（API Key、语言）');
      if (isOpen(langPanel)) renderLangPanel();
    }
    if (myLangChanged || enabledChanged || keyAdded || uiChanged) resetTranslations();
    settingsListeners.forEach((fn) => fn(s));
  }

  // ---------------- 插件更新后退场 ----------------
  function retire() {
    if (dead) return;
    dead = true;
    if (rec) stopDictation(true);
    document.querySelectorAll('#trx-bar, .trx-panel, #trx-preview, #trx-vs, #trx-toasts, .wa-tr-line').forEach((x) => x.remove());
    // 新版本脚本一般会自动接手；几秒后还没有，就提示刷新
    setTimeout(() => {
      if (document.getElementById('trx-bar')) return;
      const box = document.createElement('div');
      box.id = 'trx-dead';
      box.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483002;padding:10px 14px;border-radius:8px;background:#8a5a00;color:#fff;font:13px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3)';
      box.textContent = T('翻译插件已更新，刷新网页后继续使用');
      const b = document.createElement('button');
      b.textContent = T('刷新网页');
      b.style.cssText = 'margin-left:10px;background:rgba(255,255,255,.25);color:#fff;border:none;border-radius:4px;padding:3px 10px;cursor:pointer';
      b.onclick = () => location.reload();
      box.appendChild(b);
      document.body.appendChild(box);
    }, 4000);
  }

  // ---------------- 启动 ----------------
  async function start() {
    const st = document.createElement('style');
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);

    settings = await ipcRenderer.invoke('tr:get-settings');
    i18n.setLang(settings.uiLang);
    chatLang = settings.defaultTheirLang;
    try {
      const t = await ipcRenderer.invoke('tr:get-tones');
      if (t && Object.keys(t).length) tones = t;
    } catch (_) {}

    // 按钮从下往上：译 / 语言 / 设置 / （扩展按钮）
    addFab({ id: 'trx-settings-fab', text: '⚙', title: T('设置（API Key、语言）'), color: '#37474f', atStart: true, onClick: () => ipcRenderer.invoke('tr:open-settings') });
    langFab = addFab({
      atStart: true,
      id: 'trx-lang-fab',
      text: 'EN',
      color: '#6d3b8f',
      onClick: () => {
        ensureChat();
        renderLangPanel();
        togglePanel(langPanel);
      },
    });
    trFab = addFab({ id: 'trx-tr-fab', text: T('译'), color: '#00a884', atStart: true, onClick: () => translateDraft(null, false) });
    if (adapter.getVoiceInfo)
      micFab = addFab({ id: 'trx-mic-fab', text: '🎤', color: '#1e88e5', title: T('说中文：点一下开始录音，再点一下结束，自动翻译成对方语言'), atStart: true, onClick: () => toggleDictation() });
    if (adapter.voiceSend) {
      voiceSendFab = addFab({ id: 'trx-vs-fab', text: '🔊', color: '#5e35b1', title: T('发语音条：把输入框里的话翻译后合成语音发出去（Alt+V）'), atStart: true, onClick: () => sendAsVoice(null) });
      voiceSendFab.style.display = settings.voiceSend === false ? 'none' : '';
    }
    document.body.appendChild(bar);
    if (settings.toolbarPos) applyBarPos(settings.toolbarPos);
    readyListeners.forEach((fn) => {
      try {
        fn(settings);
      } catch (err) {
        console.error('[translator] ready listener failed', err);
      }
    });
    updateLangFab();
    updateTrFab();

    installIntercept();
    installVoice();
    installImages();
    syncVoiceAttr();
    ipcRenderer.on('tr:settings-changed', (e, s) => applySettings(s));
    ipcRenderer.on('tr:ext-dead', () => retire());

    // 上一个（插件更新前的）脚本留下的东西清掉
    document.querySelectorAll('#trx-dead, #trx-bar:not(:empty)').forEach((x) => x !== bar && x.remove());
    new MutationObserver(() => !dead && scheduleScan()).observe(document.body, { childList: true, subtree: true, characterData: true });
    docOn('scroll', scheduleScan, { capture: true, passive: true });
    setInterval(scheduleScan, 2000);
    scan();
    if (!settings.hasKey) toast(T('还没有配置 API Key，点右下角 ⚙ 设置'), 'warn', { ms: 6000 });
  }

  return {
    start,
    ipc: ipcRenderer,
    toast,
    escapeHtml,
    addFab,
    createPanel,
    openPanel,
    closePanel,
    togglePanel,
    isOpen,
    getSettings: () => settings,
    getChat: () => ({ ...ensureChat(), lang: chatLang }),
    onMessage: (fn) => messageListeners.push(fn),
    onChatChange: (fn) => chatListeners.push(fn),
    onSettings: (fn) => settingsListeners.push(fn),
    onReady: (fn) => readyListeners.push(fn),
    // 把文字填进输入框（不发送），之后按回车不会再翻译一次
    async fillComposer(text) {
      const box = adapter.getComposer() || lastComposer;
      if (!box) return toast(T('没找到输入框，请先打开聊天'), 'warn');
      try {
        await replaceComposer(box, text);
      } catch (err) {
        toast(errText(err), 'error', { copy: text });
      }
    },
  };
}

// 语音消息抓取脚本注入网页主环境（桌面版）；插件版由 manifest 的 MAIN world 内容脚本负责
function injectVoiceHook() {
  try {
    const electron = require('electron');
    if (electron.webFrame && electron.webFrame.executeJavaScript) {
      const { HOOK_SOURCE } = require('./voice-hook');
      electron.webFrame.executeJavaScript(HOOK_SOURCE).catch(() => {});
    }
  } catch (_) {}
}

function boot(adapter, extras) {
  if (adapter.getVoiceInfo || adapter.getImageInfo || adapter.voiceSend) injectVoiceHook();
  const run = async () => {
    const ui = createTranslatorUI(adapter);
    if (extras) {
      try {
        await extras(ui); // 先注册监听（如 Wingman），再开始扫描，避免漏掉第一批消息
      } catch (err) {
        console.error('[translator] extras failed', err);
      }
    }
    await ui.start();
  };
  if (document.body) run();
  else document.addEventListener('DOMContentLoaded', run);
}

module.exports = { boot, readRichText, escapeHtml, waitFor };
