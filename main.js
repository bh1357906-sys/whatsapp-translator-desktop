// WA Translator 主进程入口：只放本应用的配置，通用逻辑在 core/
'use strict';

const path = require('path');
const { createTranslatorApp } = require('./core/main-core');
const { createWingman, WINGMAN_DEFAULTS, WINGMAN_PAGE_KEYS } = require('./wingman/wingman-service');

createTranslatorApp({
  appName: 'WA Translator',
  shortName: 'wa-translator',
  url: 'https://web.whatsapp.com/',
  allowedHosts: ['web.whatsapp.com'],
  repo: 'bh1357906-sys/whatsapp-translator-desktop',
  preload: path.join(__dirname, 'preload.js'),
  extraDefaults: WINGMAN_DEFAULTS,
  extraPageKeys: WINGMAN_PAGE_KEYS,
  createExtras: (service, kv) => createWingman({ service, kv }),
});
