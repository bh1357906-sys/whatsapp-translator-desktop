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
