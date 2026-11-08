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

// 各种界面语言下“发送”按钮的文字（WhatsApp 跟随系统语言，繁体是“傳送”）
const SEND_LABEL = /^(send|发送|發送|傳送|传送|送出|enviar|envoyer|senden|invia|kirim|hantar|отправить|送信|전송|ส่ง|gönder|gửi|إرسال|שלח|bhejein|भेजें)$/i;

function isSendButton(b) {
  if (!b) return false;
  const label = (b.getAttribute('aria-label') || '').trim();
  if (SEND_LABEL.test(label)) return true;
  const tid = b.getAttribute('data-testid') || '';
  if (tid === 'send' || tid === 'compose-btn-send') return true;
  return !!b.querySelector('[data-icon="send"], [data-icon="wds-ic-send-filled"], [data-icon*="send"]');
}

// 消息气泡在聊天区左边 = 对方发的，右边 = 自己发的（新版 WhatsApp 只能这样判断）
function bubbleSide(el) {
  const main = mainPanel();
  const box = el.querySelector('[data-testid="msg-container"]') || el;
  const r = box.getBoundingClientRect();
  if (!main || !r.width) return null;
  const m = main.getBoundingClientRect();
  return r.left + r.width / 2 > m.left + m.width / 2 ? 'R' : 'L';
}

function mainPanel() {
  return document.querySelector('#main') || document.querySelector('[data-testid="conversation-panel-wrapper"]');
}

function msgId(el) {
  return el.getAttribute('data-id') || (el.getAttribute('data-testid') || '').replace(/^conv-msg-/, '');
}

function isIncoming(el, id) {
  const parsed = parseDataId(id);
  if (parsed) return !parsed.out;
  if (el.querySelector('.message-out') || el.classList.contains('message-out')) return false;
  if (el.querySelector('.message-in') || el.classList.contains('message-in')) return true;
  if (el.querySelector('[data-icon="tail-out"], [data-testid="tail-out"]')) return false;
  if (el.querySelector('[data-icon="tail-in"], [data-testid="tail-in"]')) return true;
  const side = bubbleSide(el);
  return side ? side === 'L' : true;
}

// 语音消息的播放键（各种界面语言）；排除“播放速度”“转发”等按钮
const PLAY_LABEL = /播放|暫停|暂停|play|pause|reproduc|putar|main|lecture|abspielen|riproduci|воспроизв|再生|재생|เล่น|oynat|phát|تشغيل/i;
const NOT_PLAY = /速度|speed|倍|velocidad|kecepatan|vitesse|geschwindigkeit|velocità|скорость|速|속도|ความเร็ว|hız|tốc độ|سرعة|轉寄|转发|forward/i;

const adapter = {
  getMessageElements() {
    const root = mainPanel();
    if (!root) return [];
    // 新版：[data-testid^="conv-msg-"]；旧版：data-id="true_xxx@c.us_ID"
    let els = Array.from(root.querySelectorAll('[data-testid^="conv-msg-"]'));
    if (!els.length)
      els = Array.from(root.querySelectorAll('[data-id]')).filter(
        (el) => parseDataId(el.getAttribute('data-id')) && !(el.parentElement && el.parentElement.closest('[data-id]'))
      );
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

    const id = msgId(el);
    const incoming = isIncoming(el, id);

    const mount = el.querySelector('.message-in, .message-out') || el;
    const pre = ct.getAttribute('data-pre-plain-text') || ''; // "[10:30, 1/11/2026] 名字: "
    const sender = (pre.match(/\]\s*([^:]+):\s*$/) || [])[1] || '';
    return { id, text, incoming, mount, sender: sender.trim() };
  },

  // 语音消息（含音频文件）：有进度滑桿 + 播放键，没有文字
  getVoiceInfo(el) {
    const slider = el.querySelector('[role="slider"], input[type="range"]');
    if (!slider) return null;
    const buttons = Array.from(el.querySelectorAll('button, [role="button"]')).filter((b) => !b.closest('.wa-tr-line'));
    const label = (b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
    let playBtn = buttons.find((b) => PLAY_LABEL.test(label(b)) && !NOT_PLAY.test(label(b)));
    if (!playBtn) playBtn = buttons.find((b) => b.querySelector('[data-icon*="play"], [data-icon*="pause"], [data-icon*="ptt"], [data-icon*="audio"]'));
    if (!playBtn)
      playBtn = buttons.find((b) => !NOT_PLAY.test(label(b)) && b.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!playBtn) return null;
    const id = msgId(el);
    if (!id) return null;
    const mount = el.querySelector('.message-in, .message-out') || el;
    return { id, incoming: isIncoming(el, id), mount, playBtn, voice: true };
  },

  // 图片消息（截图 / 照片 / 文档缩略图）：取消息里最大的那张图；头像、表情贴纸不算
  getImageInfo(el) {
    const imgs = Array.from(el.querySelectorAll('img')).filter((img) => {
      if (img.closest('.wa-tr-line, [data-testid*="sticker"], [data-icon], header, .quoted-mention')) return false;
      const src = img.currentSrc || img.src || '';
      if (!/^(blob:|data:image)/.test(src)) return false;
      if (img.alt && /sticker|贴纸/i.test(img.alt)) return false;
      const r = img.getBoundingClientRect();
      return r.width >= 80 && r.height >= 60;
    });
    if (!imgs.length) return null;
    const img = imgs.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
    const id = msgId(el);
    if (!id) return null;
    const mount = el.querySelector('.message-in, .message-out') || el;
    return { id: 'img:' + id, incoming: isIncoming(el, id), mount, img };
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

  // 点击的是不是发送按钮（支持各种界面语言）
  sendButtonFrom(target) {
    const b = target && target.closest ? target.closest('button, [role="button"]') : null;
    if (!b || !b.closest('#main footer, [role="dialog"], [data-animate-modal-body]')) return null;
    return isSendButton(b) ? b : null;
  },

  // 输入区（发送键、附件、表情都在这里）：护栏用它判断“点的是不是输入区里的按钮”
  sendArea(el) {
    return el && el.closest ? el.closest('#main footer, [role="dialog"], [data-animate-modal-body]') : null;
  },

  composerForButton(btn) {
    // 图片预览里的发送按钮 → 对应的配文输入框
    const dlg = btn.closest('[role="dialog"]') || btn.closest('[data-animate-modal-body]');
    if (dlg) {
      const c = dlg.querySelector('[contenteditable="true"]');
      if (c) return c;
    }
    return adapter.getComposer();
  },

  // 发语音条：录音键 / 录音中的取消键和发送键（各种界面语言）
  voiceSend: {
    visible: (el) => !!el && el.getClientRects().length > 0,
    micButton() {
      const btns = Array.from(document.querySelectorAll('#main footer button, #main footer [role="button"]')).filter((b) => !b.closest('#trx-bar') && this.visible(b));
      // 取最内层的那个（WhatsApp 会套两层）
      const hits = btns.filter(
        (b) =>
          /语音消息|語音訊息|voice message|mensaje de voz|message vocal|sprachnachricht|mensagem de voz|messaggio vocale|pesan suara|mesej suara|音声メッセージ|음성 메시지|голосов|tin nhắn thoại|ข้อความเสียง|sesli mesaj|رسالة صوتية|voice note/i.test(b.getAttribute('aria-label') || '') ||
          b.querySelector('[data-icon*="ptt"], [data-icon*="mic"]') ||
          /\bic-mic\b/.test(b.textContent || '')
      );
      return hits.find((b) => !hits.some((o) => o !== b && b.contains(o))) || null;
    },
    cancelButton() {
      return (
        Array.from(document.querySelectorAll('#main footer button')).find(
          (b) =>
            this.visible(b) &&
            (/取消|cancel|delete|删除|löschen|eliminar|supprimer|excluir|hapus|padam|削除|삭제|удалить|xóa|ลบ|sil|حذف/i.test(b.getAttribute('aria-label') || '') || /\bic-delete\b/.test(b.textContent || '') || b.querySelector('[data-icon*="ptt-cancel"], [data-icon*="delete"]'))
        ) || null
      );
    },
    isRecording() {
      return !!this.cancelButton() && !!this.sendButton();
    },
    sendButton() {
      const btns = Array.from(document.querySelectorAll('#main footer button, #main footer [role="button"]')).filter((b) => !b.closest('#trx-bar') && this.visible(b));
      const hits = btns.filter((b) => isSendButton(b) || /ic-send-filled|\bic-send\b/.test(b.textContent || ''));
      return hits.find((b) => !hits.some((o) => o !== b && b.contains(o))) || null;
    },
  },

  findSendButton(box) {
    const scope = (box && (box.closest('footer') || box.closest('[role="dialog"]'))) || document.querySelector('#main footer') || document;
    return Array.from(scope.querySelectorAll('button, [role="button"]')).find(isSendButton) || null;
  },
};

boot(adapter, installWingman);
