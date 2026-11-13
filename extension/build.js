// 生成 Chrome 插件：把共享代码打包成内容脚本 / 后台脚本
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join(__dirname, '..', '..', 'translator-chrome-extension');
const WA = path.join(__dirname, '..');
const TG = path.join(__dirname, '..', '..', 'telegram-translator-desktop'); // 两个项目需放在同一个上级目录
const SRC = path.join(__dirname, 'src');
const extraHosts = (process.env.EXTRA_HOSTS || '').split(',').filter(Boolean); // 仅测试用
const version = JSON.parse(fs.readFileSync(path.join(WA, 'package.json'), 'utf8')).version;

function bundle(mods, entry, banner) {
  const defs = Object.entries(mods)
    .map(([name, file]) => {
      const src = fs.readFileSync(file, 'utf8');
      return JSON.stringify(name) + ': function (module, exports, require) {\n' + src + '\n}';
    })
    .join(',\n');
  return `// ${banner}\n// 由 build.js 生成，源码见桌面版项目的 core/ 等目录\n(function () {
'use strict';
const defs = {
${defs}
};
const cache = {};
function req(from) {
  return function (p) {
    let base = from;
    if (p === 'electron') {
      base = '';
      p = './ext/electron-shim';
    }
    const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
    const parts = dir ? dir.split('/') : [];
    for (const seg of p.split('/')) {
      if (seg === '.' || !seg) continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const name = parts.join('/').replace(/\\.js$/, '');
    if (cache[name]) return cache[name].exports;
    if (!defs[name]) throw new Error('module not found: ' + name);
    const m = { exports: {} };
    cache[name] = m;
    defs[name](m, m.exports, req(name));
    return m.exports;
  };
}
if (globalThis.__trxLoaded) return;
globalThis.__trxLoaded = true;
req('')(${JSON.stringify('./' + entry)});
})();
`;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const core = {
  'core/lang': path.join(WA, 'core/lang.js'),
  'core/i18n': path.join(WA, 'core/i18n.js'),
  'core/renderer-core': path.join(WA, 'core/renderer-core.js'),
};

fs.writeFileSync(
  path.join(OUT, 'wa-content.js'),
  bundle(
    { ...core, 'wa-preload': path.join(WA, 'preload.js'), 'wingman/wingman-ui': path.join(WA, 'wingman/wingman-ui.js'), 'ext/electron-shim': path.join(SRC, 'electron-shim.js') },
    'wa-preload',
    'WhatsApp Web 内容脚本'
  )
);
fs.writeFileSync(
  path.join(OUT, 'tg-content.js'),
  bundle({ ...core, 'tg-preload': path.join(TG, 'preload.js'), 'ext/electron-shim': path.join(SRC, 'electron-shim.js') }, 'tg-preload', 'Telegram Web 内容脚本')
);
fs.writeFileSync(
  path.join(OUT, 'background.js'),
  bundle(
    {
      'core/lang': path.join(WA, 'core/lang.js'),
      'core/i18n': path.join(WA, 'core/i18n.js'),
      'core/service': path.join(WA, 'core/service.js'),
      'wingman/wingman-service': path.join(WA, 'wingman/wingman-service.js'),
      'ext/background-main': path.join(SRC, 'background-main.js'),
    },
    'ext/background-main',
    '插件后台'
  )
);

// 语音消息抓取脚本（运行在网页主环境）
fs.writeFileSync(
  path.join(OUT, 'voice-hook-main.js'),
  '// 由 build.js 生成：语音消息抓取（只读本地音频，交给翻译脚本）\n' + require(path.join(WA, 'core/voice-hook.js')).HOOK_SOURCE + '\n'
);

// Telegram 网页的 A 版（web.telegram.org/a/ 等）不支持：页面上方给出醒目提示，一键切到 K 版
fs.writeFileSync(
  path.join(OUT, 'tg-version-notice.js'),
  `// 由 build.js 生成：不支持的 Telegram 网页版本提示
(function () {
  if (/^\\/k(\\/|$)/.test(location.pathname)) return;
  function show() {
    if (!document.body || document.getElementById('trx-ver-note')) return;
    const box = document.createElement('div');
    box.id = 'trx-ver-note';
    box.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483003;max-width:90vw;padding:10px 14px;border-radius:8px;background:#b3261e;color:#fff;font:13px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3)';
    box.textContent = '翻译助手只支持 Telegram 网页的 K 版。现在这个页面上不会翻译，中文会被原样发出！ (Translator works on Telegram Web K only) ';
    const b = document.createElement('button');
    b.textContent = '切换到 K 版 / Switch to K';
    b.style.cssText = 'margin-left:10px;background:rgba(255,255,255,.25);color:#fff;border:none;border-radius:4px;padding:3px 10px;cursor:pointer';
    b.onclick = function () {
      location.replace('https://web.telegram.org/k/');
    };
    box.appendChild(b);
    document.body.appendChild(box);
  }
  show();
  document.addEventListener('DOMContentLoaded', show);
  setInterval(show, 3000);
})();
`
);

// 设置页
let html = fs.readFileSync(path.join(WA, 'settings.html'), 'utf8');
html = html.replace('<script src="settings.js"></script>', '<script src="settings-api.js"></script>\n<script src="settings.js"></script>');
fs.writeFileSync(path.join(OUT, 'options.html'), html);
fs.copyFileSync(path.join(WA, 'settings.js'), path.join(OUT, 'settings.js'));
fs.mkdirSync(path.join(OUT, 'core'), { recursive: true });
fs.copyFileSync(path.join(WA, 'core/i18n.js'), path.join(OUT, 'core/i18n.js'));
fs.copyFileSync(path.join(SRC, 'settings-api.js'), path.join(OUT, 'settings-api.js'));

fs.copyFileSync(path.join(__dirname, 'README.md'), path.join(OUT, 'README.md'));

// 图标
['16', '48', '128'].forEach((s) => {
  const f = path.join(__dirname, 'icons', 'icon' + s + '.png');
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join(OUT, 'icon' + s + '.png'));
});

const manifest = {
  manifest_version: 3,
  name: 'WA & TG 翻译助手',
  version,
  description: 'WhatsApp Web / Telegram Web 自动翻译：收到的消息显示中文，中文按回车自动翻译成对方语言再发送；语音消息转文字翻译，说中文自动翻译。',
  icons: { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' },
  action: { default_title: '翻译助手设置', default_icon: { 16: 'icon16.png', 48: 'icon48.png' } },
  options_ui: { page: 'options.html', open_in_tab: true },
  background: { service_worker: 'background.js' },
  permissions: ['storage', 'unlimitedStorage', 'scripting'],
  host_permissions: ['https://api.deepseek.com/*', 'https://api.openai.com/*', 'https://generativelanguage.googleapis.com/*', 'https://api.groq.com/*', 'https://api.elevenlabs.io/*', 'https://web.whatsapp.com/*', 'https://web.telegram.org/*', ...extraHosts],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  content_scripts: [
    { matches: ['https://web.whatsapp.com/*', 'https://web.telegram.org/k/*'], js: ['voice-hook-main.js'], run_at: 'document_start', world: 'MAIN' },
    // document_start：发送闸门要赶在聊天网页自己的脚本之前装好（界面等页面加载完再建）
    { matches: ['https://web.whatsapp.com/*'], js: ['wa-content.js'], run_at: 'document_start' },
    { matches: ['https://web.telegram.org/k/*'], js: ['tg-content.js'], run_at: 'document_start' },
    { matches: ['https://web.telegram.org/*'], exclude_matches: ['https://web.telegram.org/k/*'], js: ['tg-version-notice.js'], run_at: 'document_idle' },
  ],
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('built', OUT, 'v' + version);
