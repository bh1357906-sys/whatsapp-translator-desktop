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

// service worker 随时可能被回收：缓存定期落盘
chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener(() => service.flush());
