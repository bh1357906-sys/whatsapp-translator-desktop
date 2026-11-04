// WA Translator 主进程入口：只放本应用的配置，通用逻辑在 core/
'use strict';

const path = require('path');
const fs = require('fs');

if (!fs.existsSync(path.join(__dirname, 'dist-preload', 'preload.js'))) {
  console.error('[translator] dist-preload/preload.js 不存在：请先运行 npm run build（npm start 会自动构建）');
  process.exit(1);
}
const { createTranslatorApp } = require('./core/main-core');
const { createWingman, WINGMAN_DEFAULTS, WINGMAN_PAGE_KEYS } = require('./wingman/wingman-service');

createTranslatorApp({
  appName: 'WA Translator',
  shortName: 'wa-translator',
  url: 'https://web.whatsapp.com/',
  allowedHosts: ['web.whatsapp.com'],
  repo: 'bh1357906-sys/whatsapp-translator-desktop',
  // 聊天页面的 preload 用打包后的单文件（npm run build 生成），这样页面可以开沙箱
  preload: path.join(__dirname, 'dist-preload', 'preload.js'),
  icon: path.join(__dirname, 'build', 'icon.png'),
  extraDefaults: WINGMAN_DEFAULTS,
  extraPageKeys: WINGMAN_PAGE_KEYS,
  createExtras: (service, kv) => createWingman({ service, kv }),
});
