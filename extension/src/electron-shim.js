// 插件内容脚本里代替 Electron 的 ipcRenderer：把调用转发给后台，输入框写入/发送在页面里直接完成
'use strict';

const listeners = {};
let invalidated = false;
const DEAD_MSG = '插件已更新或重新加载，请刷新这个网页 (EXT_DEAD)';

function emit(ch, arg) {
  (listeners[ch] || []).forEach((fn) => {
    try {
      fn({}, arg);
    } catch (_) {}
  });
}

function send(ch, arg) {
  return new Promise((resolve, reject) => {
    if (invalidated || !chrome.runtime || !chrome.runtime.id) {
      markDead();
      return reject(new Error(DEAD_MSG));
    }
    try {
      chrome.runtime.sendMessage({ __trx: 1, ch, arg: arg === undefined ? null : arg }, (res) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(le.message));
        if (!res) return reject(new Error('后台没有响应'));
        if (!res.ok) return reject(new Error(res.error));
        resolve(res.result);
      });
    } catch (err) {
      markDead();
      reject(new Error(DEAD_MSG));
    }
  });
}

// 插件被更新 / 重新加载后，这个脚本就成了“孤儿”：通知页面代码退场，让新注入的脚本接手
function markDead() {
  if (invalidated) return;
  invalidated = true;
  globalThis.__trxLoaded = false;
  setTimeout(() => emit('tr:ext-dead'), 0);
}
// 和后台保持一条连接：插件重新加载时连接会断开，借此马上发现
(function watch() {
  try {
    const port = chrome.runtime.connect({ name: 'trx-page' });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      let alive = false;
      try {
        alive = !!(chrome.runtime && chrome.runtime.id);
      } catch (_) {}
      // 后台只是休眠了（连接被回收）→ 重连；插件真的没了 → 退场
      if (alive) setTimeout(watch, 1000);
      else markDead();
    });
  } catch (_) {
    markDead();
  }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEND_LABEL = /^(send|发送|發送|傳送|传送|送出|enviar|envoyer|senden|invia|kirim|hantar|отправить|送信|전송|ส่ง|gönder|gửi|إرسال|שלח|bhejein|भेजें)$/i;
function isSendButton(b) {
  if (SEND_LABEL.test((b.getAttribute('aria-label') || '').trim())) return true;
  const tid = b.getAttribute('data-testid') || '';
  if (tid === 'send' || tid === 'compose-btn-send') return true;
  return !!b.querySelector('[data-icon*="send"]');
}

const local = {
  // 全选后用浏览器原生编辑命令写入（会触发编辑器自己的输入事件）
  async 'tr:compose-insert'({ text }) {
    document.execCommand('selectAll');
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i) document.execCommand('insertLineBreak');
      if (lines[i]) document.execCommand('insertText', false, lines[i]);
    }
    await sleep(20);
    return true;
  },
  // sendKey：'enter' | 'ctrlEnter'（和设置里“聊天软件里的发送键”一致）
  async 'tr:compose-enter'({ sendKey } = {}) {
    const el = document.activeElement;
    const ctrl = sendKey === 'ctrlEnter';
    // WhatsApp：直接点发送按钮最可靠
    if (location.host === 'web.whatsapp.com' && el) {
      const scope = el.closest('footer') || el.closest('[role="dialog"]') || document.querySelector('#main footer') || document;
      const btn = Array.from(scope.querySelectorAll('button, [role="button"]')).find(isSendButton);
      if (btn) {
        btn.click();
        return true;
      }
    }
    if (el) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: ctrl };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
    return true;
  },
};

// 插件版没有系统通知权限，忽略
local['tr:notify'] = async () => false;

const ipcRenderer = {
  invoke(ch, arg) {
    if (local[ch]) return local[ch](arg || {});
    return send(ch, arg);
  },
  on(ch, fn) {
    (listeners[ch] = listeners[ch] || []).push(fn);
  },
};

// 设置页保存后，页面自动拿到新设置
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.settings) {
      send('tr:get-settings')
        .then((s) => emit('tr:settings-changed', s))
        .catch(() => {});
    }
  });
} catch (_) {}

module.exports = { ipcRenderer };
