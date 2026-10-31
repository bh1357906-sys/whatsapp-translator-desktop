// WhatsApp Web 页面适配器
// WhatsApp 会不定期改页面结构，所有选择器都集中在这里，失效时只改这个文件。
'use strict';

const { boot, readRichText } = require('./core/renderer-core');
const { installWingman } = require('./wingman/wingman-ui');

const QUOTE_SEL = '[data-testid="quoted-message"], .quoted-mention, [aria-label*="uoted" i], [aria-label*="引用"]';

// 消息 data-id 形如 "false_60123456789@c.us_3EB0ABC..."：true=自己发的，false=收到的，中间是聊天 JID
function parseDataId(id) {
  const m = /^(true|false)_([^_]+@[a-z.]+)_/.exec(id || '');
  return m ? { out: m[1] === 'true', jid: m[2] } : null;
}

function mainPanel() {
  return document.querySelector('#main') || document.querySelector('[data-testid="conversation-panel-wrapper"]');
}

const adapter = {
  getMessageElements() {
    const root = mainPanel();
    if (!root) return [];
    let els = Array.from(root.querySelectorAll('[data-id]')).filter(
      (el) => parseDataId(el.getAttribute('data-id')) && !(el.parentElement && el.parentElement.closest('[data-id]'))
    );
    if (!els.length) els = Array.from(root.querySelectorAll('[data-testid^="conv-msg-"]'));
    return els;
  },

  getMessageInfo(el) {
    const ct = el.querySelector('.copyable-text[data-pre-plain-text]');
    if (!ct) return null; // 图片/语音/贴纸等没有文字
    // 正文：不在引用块里的 selectable-text
    const spans = Array.from(ct.querySelectorAll('span.selectable-text')).filter((s) => !s.closest(QUOTE_SEL) && !s.matches('.quoted-mention'));
    let text = '';
    if (spans.length) {
      const outer = spans.filter((s) => !spans.some((o) => o !== s && o.contains(s)));
      text = outer.map((s) => readRichText(s, QUOTE_SEL)).join('\n').trim();
    } else {
      text = readRichText(ct, QUOTE_SEL);
    }
    if (!text) return null;

    const id = el.getAttribute('data-id') || '';
    const parsed = parseDataId(id);
    let incoming;
    if (parsed) incoming = !parsed.out;
    else if (el.querySelector('.message-out') || el.classList.contains('message-out')) incoming = false;
    else if (el.querySelector('.message-in') || el.classList.contains('message-in')) incoming = true;
    else if (el.querySelector('span[data-icon="tail-out"]')) incoming = false;
    else incoming = true;

    const mount = el.querySelector('.message-in, .message-out') || el;
    const pre = ct.getAttribute('data-pre-plain-text') || ''; // "[10:30, 1/11/2026] 名字: "
    const sender = (pre.match(/\]\s*([^:]+):\s*$/) || [])[1] || '';
    return { id, text, incoming, mount, sender: sender.trim() };
  },

  getChat() {
    const root = mainPanel();
    if (!root) return null;
    const header = root.querySelector('header');
    let name = '';
    if (header) {
      const t =
        header.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
        header.querySelector('span[dir="auto"][title]') ||
        header.querySelector('span[dir="auto"]');
      name = t ? (t.getAttribute('title') || t.textContent || '').trim() : '';
    }
    // 从最后一条消息的 data-id 取聊天 JID（比名字稳定，也含电话号码）
    let jid = '';
    const ids = root.querySelectorAll('[data-id]');
    for (let i = ids.length - 1; i >= 0 && !jid; i--) {
      const p = parseDataId(ids[i].getAttribute('data-id'));
      if (p) jid = p.jid;
    }
    if (!name && !jid) return null;
    const number = /^(\d{6,})@c\.us$/.test(jid) ? jid.split('@')[0] : '';
    const aliases = [];
    if (jid && name) aliases.push(name);
    return { key: jid || name, name: name || number || jid, aliases, jid, number };
  },

  getComposer() {
    return (
      document.querySelector('#main footer [contenteditable="true"]') ||
      document.querySelector('[data-testid="conversation-compose-box-input"]')
    );
  },

  // 判断按键所在的是否为“要翻译的输入框”：聊天输入框、图片配文、编辑消息框都算；左侧搜索框不算
  composerFrom(target) {
    const el = target && target.closest ? target.closest('[contenteditable="true"]') : null;
    if (!el) return null;
    if (el.closest('#side, #trx-bar, .trx-panel')) return null;
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
    if (/search|搜索|查找/.test(label)) return null;
    return el;
  },

  sendButtonSelector:
    'button[aria-label="Send"], button[aria-label="发送"], button[data-testid="send"], button[data-testid="compose-btn-send"], span[data-icon="send"], span[data-icon="wds-ic-send-filled"]',

  composerForButton(btn) {
    // 图片预览里的发送按钮 → 对应的配文输入框
    const dlg = btn.closest('[role="dialog"]') || btn.closest('[data-animate-modal-body]');
    if (dlg) {
      const c = dlg.querySelector('[contenteditable="true"]');
      if (c) return c;
    }
    return adapter.getComposer();
  },

  findSendButton(box) {
    const scope = (box && (box.closest('footer') || box.closest('[role="dialog"]'))) || document;
    const el = scope.querySelector(adapter.sendButtonSelector);
    return el ? el.closest('button') || el : null;
  },
};

boot(adapter, installWingman);
