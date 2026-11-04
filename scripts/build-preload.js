// 把页面 preload（及其依赖的 core/、wingman/）打成一个文件，这样聊天页面可以开 sandbox: true
// 用法：node scripts/build-preload.js   （npm start / npm run dist 会自动跑）
'use strict';
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-preload');
fs.mkdirSync(outDir, { recursive: true });

esbuild
  .build({
    entryPoints: [path.join(root, 'preload.js')],
    outfile: path.join(outDir, 'preload.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'chrome120',
    external: ['electron'],
    minify: false, // voice-hook 依赖 Function.toString()，不能压缩
    legalComments: 'none',
    logLevel: 'info',
  })
  .then(() => {
    // 简单自检：确保没有残留的 require('./...')
    const out = fs.readFileSync(path.join(outDir, 'preload.js'), 'utf8');
    if (/require\(["']\.\.?\//.test(out)) throw new Error('bundle still has relative require()');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
