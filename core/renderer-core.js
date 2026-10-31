// 页面侧共享核心（在 WhatsApp Web / Telegram Web 页面里运行，隔离环境）
// 负责：扫描消息并显示翻译行、按聊天记住语言、拦截发送并翻译、工具栏和面板
'use strict';

const { ipcRenderer } = require('electron');
const lang = require('./lang');

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
#trx-toasts{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483002;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.trx-toast{pointer-events:auto;max-width:560px;padding:9px 14px;border-radius:8px;background:#323739;color:#fff;font:13px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);white-space:pre-wrap;word-break:break-word}
.trx-toast.trx-error{background:#b3261e}
.trx-toast.trx-warn{background:#8a5a00}
.trx-toast button{margin-left:10px;background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:4px;padding:2px 8px;cursor:pointer}
`;

function createTranslatorUI(adapter) {
  let settings = null;
  const chat = { key: null, name: null, aliases: [], number: '' };
  let chatLang = 'English';
  let chatLangReady = Promise.resolve();
  let chatLangFromContact = false;

  let msgState = new WeakMap(); // 消息元素 → { key, status }
  let resultCache = new Map(); // key → 译文（null = 不需要显示）
  const messageListeners = [];
  const chatListeners = [];
  const settingsListeners = [];
  const readyListeners = [];

  let busy = false;
  let bypassUntil = 0;
  let lastTranslated = null; // 最近一次写进输入框的译文，按回车时不再重复翻译
  let lastComposer = null;

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
    if (opts && opts.copy) {
      const b = document.createElement('button');
      b.textContent = '复制译文';
      b.onclick = () => {
        navigator.clipboard.writeText(opts.copy).catch(() => {});
        b.textContent = '已复制';
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
      '<div class="trx-h"><div><div>对方语言</div><div class="trx-sub">' +
      escapeHtml(chat.name ? '当前聊天：' + chat.name : '未识别到当前聊天') +
      '</div></div></div>';
    html +=
      '<label class="trx-row"><input type="checkbox" data-k="autoTranslateSend"' +
      (settings.autoTranslateSend ? ' checked' : '') +
      '> 按回车时自动翻译再发送</label>';
    html +=
      '<label class="trx-row"><input type="checkbox" data-k="autoTranslateIncoming"' +
      (settings.autoTranslateIncoming ? ' checked' : '') +
      '> 自动翻译聊天消息</label>';
    html +=
      '<div class="trx-row" style="cursor:default;color:#667781;font-size:12px">' +
      (chatLangFromContact ? '此聊天已单独设置语言' : '此聊天使用默认语言：' + escapeHtml(lang.langLabel(settings.defaultTheirLang))) +
      '</div>';
    html +=
      '<div class="trx-row" style="cursor:default;color:#667781;font-size:12px;display:block">' +
      'Ctrl+Enter（Mac：⌘+Enter）直接发原文，不翻译<br><span id="trx-usage">今日用量：读取中…</span>' +
      (settings.toolbarPos ? ' · <a href="#" id="trx-reset-pos" style="color:#00a884">按钮回到默认位置</a>' : '') +
      '</div>';
    lang.LANGUAGES.forEach((l) => {
      html +=
        '<div class="trx-item' + (l.name === cur ? ' trx-cur' : '') + '" data-lang="' + escapeHtml(l.name) + '"><span>' +
        escapeHtml(l.label || l.name) + '</span><span style="color:#999">' + escapeHtml(l.code) + '</span></div>';
    });
    langPanel.innerHTML = html;
    langPanel.querySelectorAll('input[data-k]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        settings = await ipcRenderer.invoke('tr:patch-settings', { [cb.dataset.k]: cb.checked });
        applySettings(settings);
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
        if (el && u) el.textContent = '今日用量：' + u.today.requests + ' 次 / ' + u.today.tokens.toLocaleString() + ' tokens（本月 ' + u.month.tokens.toLocaleString() + '）';
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
    langFab.title = '对方语言：' + lang.langLabel(chatLang) + (chat.name ? '（' + chat.name + '）' : '') + ' — 点击切换';
  }
  function updateTrFab() {
    if (!trFab || !settings) return;
    trFab.classList.toggle('trx-off', !settings.autoTranslateSend);
    trFab.title = settings.autoTranslateSend
      ? '回车自动翻译：开。点此只翻译草稿不发送（Alt+T）'
      : '回车自动翻译：关（在语言面板里打开）。点此翻译草稿（Alt+T）';
  }

  async function setChatLang(l) {
    chatLang = l;
    if (chat.key) {
      await ipcRenderer.invoke('tr:set-contact-lang', { key: chat.key, lang: l });
      chatLangFromContact = true;
    } else {
      settings = await ipcRenderer.invoke('tr:patch-settings', { defaultTheirLang: l });
      toast('没识别到当前聊天，已设为默认语言：' + lang.langLabel(l), 'warn');
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
    updateLangFab();
    const keys = [c.key, ...(c.aliases || [])];
    const myKey = c.key;
    chatLangReady = ipcRenderer
      .invoke('tr:get-contact-lang', keys)
      .then((l) => {
        if (chat.key !== myKey) return;
        if (l) {
          chatLang = l;
          chatLangFromContact = true;
        }
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

  function putLine(el, info, key, line) {
    removeLine(info);
    line.dataset.key = key;
    if (adapter.placeLine) adapter.placeLine(info, line);
    else info.mount.appendChild(line);
  }

  function removeLine(info) {
    info.mount.querySelectorAll(':scope > .wa-tr-line, .wa-tr-line').forEach((x) => x.remove());
  }

  function findLine(info) {
    return info.mount.querySelector('.wa-tr-line');
  }

  function requestTranslation(el, info, key) {
    const st = { key, status: 'pending' };
    msgState.set(el, st);
    if (resultCache.has(key)) {
      const v = resultCache.get(key);
      st.status = 'done';
      if (v) putLine(el, info, key, makeLine(info, v));
      else removeLine(info);
      return;
    }
    // 需要调接口时先显示占位
    if (lang.needsReadTranslation(info.text, settings.myLang)) putLine(el, info, key, makeLine(info, '翻译中…', 'wa-tr-pending'));
    ipcRenderer
      .invoke('tr:translate', { text: info.text, mode: 'read' })
      .then((res) => {
        const v = res && res.text ? res.text : null;
        resultCache.set(key, v);
        if (msgState.get(el) !== st) return;
        st.status = 'done';
        const cur = adapter.getMessageInfo(el) || info;
        if (v) putLine(el, cur, key, makeLine(cur, v));
        else removeLine(cur);
      })
      .catch((err) => {
        if (msgState.get(el) !== st) return;
        st.status = 'error';
        const m = errText(err);
        const noKey = m.includes('NO_KEY');
        const line = makeLine(info, noKey ? '⚠ 未配置 API Key — 点右下角 ⚙ 设置' : '⚠ 翻译失败：' + m.slice(0, 100) + '（点击重试）', 'wa-tr-error');
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
    if (!settings) return;
    ensureChat();
    let els = [];
    try {
      els = adapter.getMessageElements();
    } catch (_) {}
    const vh = window.innerHeight;
    for (let idx = 0; idx < els.length; idx++) {
      const el = els[idx];
      let info = null;
      try {
        info = adapter.getMessageInfo(el);
      } catch (_) {}
      if (!info || !info.text) continue;
      info.chatKey = chat.key;
      info.chatName = chat.name;
      info.isNewest = idx >= els.length - 3; // 屏幕上最新的几条
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
        if (st.status === 'done' && resultCache.get(key) && !findLine(info)) putLine(el, info, key, makeLine(info, resultCache.get(key)));
        continue;
      }
      // 只翻译屏幕附近的消息，省钱也不会被限流
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.bottom < -800 || r.top > vh + 800) continue;
      requestTranslation(el, info, key);
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

  async function replaceComposer(box, text) {
    box.focus();
    selectAllIn(box);
    await ipcRenderer.invoke('tr:compose-insert', { text });
    let ok = await waitFor(() => lang.looseEqual(composerText(box), text), 1200);
    if (!ok) {
      // 备用方案
      box.focus();
      selectAllIn(box);
      try {
        document.execCommand('insertText', false, text);
      } catch (_) {}
      ok = await waitFor(() => lang.looseEqual(composerText(box), text), 800);
    }
    if (!ok) {
      const e = new Error('译文没能写入输入框');
      e.copy = text;
      throw e;
    }
    lastTranslated = { text, at: Date.now() };
  }

  async function sendNow(box) {
    const liveBox = () => (box && box.isConnected ? box : adapter.getComposer());
    bypassUntil = Date.now() + 1500;
    box.focus();
    await ipcRenderer.invoke('tr:compose-enter');
    let cleared = await waitFor(() => {
      const b = liveBox();
      return !b || !composerText(b);
    }, 1500);
    if (!cleared && adapter.findSendButton) {
      const btn = adapter.findSendButton(box);
      if (btn) {
        bypassUntil = Date.now() + 1500;
        btn.click();
        cleared = await waitFor(() => {
          const b = liveBox();
          return !b || !composerText(b);
        }, 1500);
      }
    }
    if (!cleared) toast('译文已填入输入框，但没能自动发送，请手动按发送', 'warn', { ms: 5000 });
    return cleared;
  }

  let busyToast = null;
  async function translateDraft(box, andSend) {
    if (!box) box = adapter.getComposer() || lastComposer;
    if (!box || !box.isConnected) return toast('没找到输入框', 'warn');
    const text = composerText(box);
    if (!text) return;
    if (busy) return;
    busy = true;
    busyToast = toast('翻译中…', null, { ms: 0 });
    let translated = null;
    try {
      ensureChat();
      await chatLangReady;
      const target = chatLang;
      const res = await ipcRenderer.invoke('tr:translate', { text, mode: 'send', targetLang: target });
      if (!box.isConnected) throw new Error('输入框已关闭，已取消');
      if (!lang.looseEqual(composerText(box), text)) throw new Error('翻译期间草稿被修改，已取消发送（请重新按回车）');
      translated = res.text;
      if (!res.passed) await replaceComposer(box, res.text);
      else lastTranslated = { text, at: Date.now() };
      if (andSend) await sendNow(box);
    } catch (err) {
      const m = errText(err);
      if (m.includes('NO_KEY')) {
        toast('未配置 API Key，请点右下角 ⚙ 设置。消息没有发送。', 'error');
      } else {
        toast('翻译失败：' + m + (andSend ? '\n消息没有发送，草稿已保留。' : ''), 'error', { copy: err.copy || null, ms: 8000 });
      }
    } finally {
      busy = false;
      if (busyToast) busyToast.remove();
      busyToast = null;
    }
    return translated;
  }

  function shouldIntercept(box, text) {
    if (!settings.autoTranslateSend) return false;
    if (Date.now() < bypassUntil) return false;
    if (!text) return false;
    // 已经是翻译好的内容 → 原生发送
    if (lastTranslated && lang.looseEqual(text, lastTranslated.text)) return false;
    // 不需要翻译的（纯表情、外语、中文发中文）→ 原生发送，不走网络
    if (lang.outgoingPassReason(text, settings.myLang, chatLang)) return false;
    return true;
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  let swallowKeyup = false;
  function installIntercept() {
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && e.code === 'KeyT') {
          block(e);
          translateDraft(null, false);
          return;
        }
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
        if (e.altKey) return;
        const box = adapter.composerFrom(e.target);
        if (!box) return;
        if (e.ctrlKey || e.metaKey) {
          // Ctrl/⌘ + Enter：不翻译，直接发原文
          if (busy || !composerText(box)) return;
          block(e);
          swallowKeyup = true;
          sendNow(box).then((ok) => ok && toast('已发送原文（未翻译）'));
          return;
        }
        if (Date.now() < bypassUntil) return;
        if (busy) {
          // 正在翻译：吞掉回车，防止原文被发出去
          block(e);
          swallowKeyup = true;
          return;
        }
        ensureChat();
        const text = composerText(box);
        if (!shouldIntercept(box, text)) return;
        block(e);
        swallowKeyup = true;
        translateDraft(box, true);
      },
      true
    );
    document.addEventListener(
      'keyup',
      (e) => {
        if (e.key === 'Enter' && swallowKeyup) {
          block(e);
          swallowKeyup = false;
        }
      },
      true
    );
    document.addEventListener(
      'click',
      (e) => {
        if (!adapter.sendButtonSelector || !e.target || !e.target.closest) return;
        const btn = e.target.closest(adapter.sendButtonSelector);
        if (!btn || btn.closest('#trx-bar')) return;
        if (Date.now() < bypassUntil) return;
        const box = adapter.composerForButton ? adapter.composerForButton(btn) : adapter.getComposer();
        if (!box) return;
        if (busy) return block(e);
        ensureChat();
        const text = composerText(box);
        if (!shouldIntercept(box, text)) return;
        block(e);
        translateDraft(box, true);
      },
      true
    );
    document.addEventListener(
      'focusin',
      (e) => {
        const box = adapter.composerFrom(e.target);
        if (box) lastComposer = box;
      },
      true
    );
  }

  // ---------------- 设置 ----------------
  function applySettings(s) {
    const myLangChanged = settings && s.myLang !== settings.myLang;
    const enabledChanged = settings && (s.autoTranslateIncoming !== settings.autoTranslateIncoming || s.showOwnTranslation !== settings.showOwnTranslation);
    const keyAdded = settings && !settings.hasKey && s.hasKey;
    settings = s;
    if (!chatLangFromContact) chatLang = s.defaultTheirLang;
    updateLangFab();
    updateTrFab();
    if (isOpen(langPanel)) renderLangPanel();
    if (myLangChanged || enabledChanged || keyAdded) resetTranslations();
    settingsListeners.forEach((fn) => fn(s));
  }

  // ---------------- 启动 ----------------
  async function start() {
    const st = document.createElement('style');
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);

    settings = await ipcRenderer.invoke('tr:get-settings');
    chatLang = settings.defaultTheirLang;

    // 按钮从下往上：译 / 语言 / 设置 / （扩展按钮）
    addFab({ id: 'trx-settings-fab', text: '⚙', title: '设置（API Key、语言）', color: '#37474f', atStart: true, onClick: () => ipcRenderer.invoke('tr:open-settings') });
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
    trFab = addFab({ id: 'trx-tr-fab', text: '译', color: '#00a884', atStart: true, onClick: () => translateDraft(null, false) });
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
    ipcRenderer.on('tr:settings-changed', (e, s) => applySettings(s));

    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('scroll', scheduleScan, { capture: true, passive: true });
    setInterval(scheduleScan, 2000);
    scan();
    if (!settings.hasKey) toast('还没有配置 API Key，点右下角 ⚙ 设置', 'warn', { ms: 6000 });
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
      if (!box) return toast('没找到输入框，请先打开聊天', 'warn');
      try {
        await replaceComposer(box, text);
      } catch (err) {
        toast(errText(err), 'error', { copy: text });
      }
    },
  };
}

function boot(adapter, extras) {
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
