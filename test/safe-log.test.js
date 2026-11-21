'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../core/safe-log');

test('诊断日志：网址只留协议和域名', () => {
  assert.equal(L.siteOf('https://acrobat.adobe.com/viewer.html?doc=secret-123#p=4'), 'https://acrobat.adobe.com');
  assert.equal(L.siteOf('blob:https://web.whatsapp.com/8f32957c-422c-4c9e-b111-000000000000'), 'blob:web.whatsapp.com');
  assert.equal(L.siteOf('about:blank'), 'about://');
  assert.equal(L.siteOf('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?x=1'), 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai');
  // 认不出来的东西不记原文
  assert.equal(L.siteOf('张三的合同 final.pdf'), '?');
  assert.equal(L.siteOf(''), '?');
  assert.equal(L.siteOf(null), '?');
});

test('诊断日志：只记内核自己打印的“被拦下 / 被拒绝”，并且去掉网址里的路径和参数', () => {
  assert.equal(
    L.cleanConsole("Refused to frame 'https://acrobat.adobe.com/viewer.html?doc=secret-123' because it violates the following Content Security Policy directive: \"frame-src 'self'\"."),
    "Refused to frame 'https://acrobat.adobe.com' because it violates the following Content Security Policy directive: \"frame-src 'self'\"."
  );
  assert.equal(L.cleanConsole("Access to fetch at 'https://dc-api.adobe.io/license?user=abc' from origin 'https://web.whatsapp.com' has been blocked by CORS policy"), "Access to fetch at 'https://dc-api.adobe.io' from origin 'https://web.whatsapp.com' has been blocked by CORS policy");
  assert.equal(L.cleanConsole('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT'), 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT');
  assert.equal(L.cleanConsole('GET blob:https://web.whatsapp.com/aaaa-bbbb net::ERR_FILE_NOT_FOUND'), 'GET blob:web.whatsapp.com net::ERR_FILE_NOT_FOUND');
  assert.equal(L.cleanConsole("Uncaught (in promise) NotAllowedError: Failed to execute 'createWritable' on 'FileSystemFileHandle': The request is not allowed"), "Uncaught (in promise) NotAllowedError: Failed to execute 'createWritable' on 'FileSystemFileHandle': The request is not allowed");
  // data: / tel: / mailto: 后面跟的是内容本身（里面可以有空格、引号、尖括号）：从那里开始整段不留
  assert.equal(L.cleanConsole("Refused to frame 'data:text/html,<h1>张三的护照号 A1234567</h1>' because it violates the policy"), "Refused to frame 'data:…");
  assert.equal(L.cleanConsole("Refused to frame 'data:text/html,<a href=\"https://x.example/secret?token=abc\">it's 张三</a>' because"), "Refused to frame 'data:…");
  assert.equal(L.cleanConsole("Not allowed to launch 'tel:+60123456789' because a user gesture is required."), "Not allowed to launch 'tel:…");
  assert.equal(L.cleanConsole("Not allowed to launch 'mailto:someone@example.com?subject=hello 张三 world' because a user gesture is required."), "Not allowed to launch 'mailto:…");
  assert.equal(L.cleanConsole("Refused to run the JavaScript URL 'javascript:alert(\"张三 60123456789\")' because it violates"), "Refused to run the JavaScript URL 'javascript:…");
  for (const leak of ['张三', 'A1234567', '60123456789', 'someone@example.com', 'secret', 'token']) {
    for (const m of ["Refused to frame 'data:text/html,<h1>张三的护照号 A1234567</h1> https://x.example/secret?token=abc 60123456789 someone@example.com' because", "Not allowed to launch 'tel:60123456789 张三 A1234567 secret token someone@example.com' x"]) assert.ok(!L.cleanConsole(m).includes(leak), leak);
  }
});

test('诊断日志：网页自己打印的内容一律不记', () => {
  for (const m of [
    'hello from the page: 张三 said hi',
    '[media] download failed for 60123456789@c.us net::ERR_FAILED',
    'Uncaught TypeError: Cannot read properties of undefined (reading "x") at blob:https://web.whatsapp.com/1234-5678',
    'message from +60 12-345 6789: 你好',
    'Error: something Refused to work',
    '',
    null,
    undefined,
  ]) assert.equal(L.cleanConsole(m), '', String(m));
  // 再长也截到 260 个字以内
  assert.ok(L.cleanConsole('Refused to ' + 'x'.repeat(2000)).length <= 260);
});

test('主进程错误：只记错误说明和“哪个文件第几行”，不记电脑上的文件夹路径（里面有 Windows 用户名）', () => {
  const err = new Error("ENOENT: no such file or directory, open 'C:\\Users\\Zhang San\\AppData\\Roaming\\WA Translator\\accounts.json'");
  err.stack = [
    'Error: ' + err.message,
    '    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:1:138078)',
    '    at Object.load (C:\\Users\\Zhang San\\AppData\\Local\\Programs\\WA Translator\\resources\\app.asar\\core\\accounts.js:12:3)',
    '    at /home/leo/app/core/main-core.js:5:1',
    '    at node:internal/process/task_queues:95:5',
    '    at fifth (x.js:1:1)',
  ].join('\n');
  const c = L.cleanError(err);
  assert.equal(c.msg, "ENOENT: no such file or directory, open '…/accounts.json'");
  assert.equal(c.stack, 'SimpleURLLoaderWrapper.<anonymous> (browser_init:1:138078) | Object.load (accounts.js:12:3) | (main-core.js:5:1) | (task_queues:95:5)');
  assert.ok(!/Zhang|Users|AppData|home|leo/.test(JSON.stringify(c)));
  // 网址也只留最后一段；不是错误对象也不出错
  assert.equal(L.cleanError(new Error('net::ERR_FAILED loading https://web.whatsapp.com/some/path/file.js')).msg, 'net::ERR_FAILED loading …/file.js');
  assert.deepEqual(L.cleanError('plain text'), { msg: 'plain text', stack: '' });
  assert.deepEqual(L.cleanError(null), { msg: '', stack: '' });
  assert.equal(L.cleanError(new Error('x'.repeat(500))).msg.length, 200);
});
