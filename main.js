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
  // WhatsApp 网页点 PDF 会在聊天里打开内置查看器（和 Adobe 合作，2026 年 7 月上线），查看器是嵌进来的另一个网站的网页。
  // 不放行的话查看器加载不出来、一直转圈。放行后这些网页只能“显示”，拿不到麦克风 / 摄像头 / 通知等权限
  thirdPartyFrames: true,
  repo: 'bh1357906-sys/whatsapp-translator-desktop',
  // 聊天页面的 preload 用打包后的单文件（npm run build 生成），这样页面可以开沙箱
  preload: path.join(__dirname, 'dist-preload', 'preload.js'),
  icon: path.join(__dirname, 'build', 'icon.png'),
  extraDefaults: WINGMAN_DEFAULTS,
  extraPageKeys: WINGMAN_PAGE_KEYS,
  createExtras: (service, kv) => createWingman({ service, kv }),
});
