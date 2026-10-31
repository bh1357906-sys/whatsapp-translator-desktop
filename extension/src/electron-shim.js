// 插件内容脚本里代替 Electron 的 ipcRenderer：把调用转发给后台，输入框写入/发送在页面里直接完成
'use strict';

const listeners = {};
let invalidated = false;

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
      invalidated = true;
      return reject(new Error('插件已更新或重新加载，请刷新这个网页'));
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
      invalidated = true;
      reject(new Error('插件已更新或重新加载，请刷新这个网页'));
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WA_SEND =
  'button[aria-label="Send"], button[aria-label="发送"], button[data-testid="send"], button[data-testid="compose-btn-send"], span[data-icon="send"], span[data-icon="wds-ic-send-filled"]';

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
  async 'tr:compose-enter'() {
    const el = document.activeElement;
    // WhatsApp：直接点发送按钮最可靠
    if (location.host === 'web.whatsapp.com' && el) {
      const scope = el.closest('footer') || el.closest('[role="dialog"]') || document;
      const btn = scope.querySelector(WA_SEND);
      if (btn) {
        (btn.closest('button') || btn).click();
        return true;
      }
    }
    if (el) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
    return true;
  },
};

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
