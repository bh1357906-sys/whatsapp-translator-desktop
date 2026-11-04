// Chrome 插件后台（service worker）：翻译服务 + 聊天助手，数据存在 chrome.storage.local
'use strict';

const { createService } = require('../core/service');
const { createWingman, WINGMAN_DEFAULTS, WINGMAN_PAGE_KEYS } = require('../wingman/wingman-service');

const area = chrome.storage.local;

const storage = {
  async loadJSON(name, fallback) {
    const r = await area.get(name);
    return r[name] === undefined ? fallback : r[name];
  },
  async saveJSON(name, value) {
    await area.set({ [name]: value });
  },
};

let logChain = Promise.resolve();
const kv = {
  async readLog() {
    const r = await area.get('wingman-log');
    return r['wingman-log'] || [];
  },
  appendLog(entry) {
    // 串行写，避免并发覆盖
    logChain = logChain.then(async () => {
      const arr = await kv.readLog();
      arr.push(entry);
      if (arr.length > 6000) arr.splice(0, arr.length - 6000);
      await area.set({ 'wingman-log': arr });
    });
    return logChain;
  },
  async get(name, fallback) {
    return storage.loadJSON(name, fallback);
  },
  async set(name, value) {
    return storage.saveJSON(name, value);
  },
};

const service = createService({
  storage,
  extraDefaults: WINGMAN_DEFAULTS,
  extraPageKeys: WINGMAN_PAGE_KEYS,
});
const wingman = createWingman({ service, kv });

const extUrl = chrome.runtime.getURL('');
const fromExtensionPage = (sender) => !!sender && typeof sender.url === 'string' && sender.url.startsWith(extUrl);
const fromChatPage = (sender) =>
  !!sender && !!sender.tab && /^https:\/\/web\.(whatsapp\.com|telegram\.org)\//.test(sender.url || '');

const pageHandlers = {
  ...service.pageHandlers,
  ...wingman,
  'tr:open-settings': async () => {
    await chrome.runtime.openOptionsPage();
    return true;
  },
};

const settingsHandlers = {
  'st:get': () =>
    service.settingsHandlers['st:get']({
      appName: 'WA & TG 翻译助手（Chrome 插件）',
      version: chrome.runtime.getManifest().version,
      canUpdate: false,
    }),
  'st:set': (p) => service.settingsHandlers['st:set'](p),
  'st:test': (p) => service.settingsHandlers['st:test'](p),
  'st:test-stt': (p) => service.settingsHandlers['st:test-stt'](p),
  // 清除本机缓存的聊天内容：译文缓存 + 聊天助手的记录 / 状态 / 档案
  'st:clear-cache': async () => {
    await service.settingsHandlers['st:clear-cache']();
    await area.remove(['wingman-log', 'wingman-state', 'wingman-profiles']);
    if (wingman['wm:reset']) await wingman['wm:reset']();
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__trx) return false;
  let fn = null;
  if (settingsHandlers[msg.ch] && fromExtensionPage(sender)) fn = settingsHandlers[msg.ch];
  else if (pageHandlers[msg.ch] && (fromChatPage(sender) || fromExtensionPage(sender))) fn = pageHandlers[msg.ch];
  if (!fn) {
    sendResponse({ ok: false, error: 'FORBIDDEN: ' + msg.ch });
    return false;
  }
  Promise.resolve()
    .then(() => fn(msg.arg))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
  return true; // 异步回复
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// 页面里的长连接（用来让页面发现插件被重新加载）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'trx-page') return;
  port.onMessage.addListener(() => {});
});

// 插件安装 / 更新 / 重新加载后，给已经打开的 WhatsApp / Telegram 网页重新装上翻译脚本，不用手动刷新
chrome.runtime.onInstalled.addListener(async () => {
  if (!chrome.scripting) return;
  const targets = [
    { url: 'https://web.whatsapp.com/*', file: 'wa-content.js' },
    { url: 'https://web.telegram.org/k/*', file: 'tg-content.js' },
  ];
  for (const t of targets) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: t.url });
    } catch (_) {}
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['voice-hook-main.js'], world: 'MAIN' });
        // 等旧脚本先退场（它发现连接断开后会自己清理）
        await new Promise((r) => setTimeout(r, 300));
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [t.file] });
      } catch (err) {
        console.warn('[translator] reinject failed', tab.id, err && err.message);
      }
    }
  }
});

// service worker 随时可能被回收：缓存定期落盘
chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener(() => service.flush());
