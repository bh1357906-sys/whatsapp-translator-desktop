'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../core/files');

test('下载：文件名清理', () => {
  assert.equal(F.cleanFileName('报价单 2026.pdf'), '报价单 2026.pdf');
  assert.equal(F.cleanFileName('a/b\\c:d*e?f"g<h>i|j.txt'), 'a_b_c_d_e_f_g_h_i_j.txt');
  assert.equal(F.cleanFileName('  ..hidden. '), 'hidden');
  assert.equal(F.cleanFileName(''), 'download');
  assert.equal(F.cleanFileName('', 'application/pdf'), 'download.pdf');
  assert.equal(F.cleanFileName('4dbc0da4-c551', 'application/pdf'), '4dbc0da4-c551.pdf'); // 没有扩展名的按类型补上
  assert.equal(F.cleanFileName('合同.docx', 'application/pdf'), '合同.docx'); // 已有扩展名的不动
  assert.equal(F.cleanFileName('CON.txt'), '_CON.txt'); // Windows 保留名
  assert.equal(F.cleanFileName('nul'), '_nul');
  const long = F.cleanFileName('长'.repeat(300) + '.pdf');
  assert.ok(long.length <= 124 && long.endsWith('.pdf'));
  assert.equal(F.cleanFileName('line\nbreak\t.pdf'), 'line_break_.pdf');
});

test('下载：同名文件不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trx-files-'));
  const a = F.uniquePath(dir, '报价单.pdf');
  assert.equal(path.basename(a), '报价单.pdf');
  // 还没写到磁盘上、但已经被上一个下载占用的名字，也不能再给出去
  const b = F.uniquePath(dir, '报价单.pdf');
  assert.equal(path.basename(b), '报价单 (1).pdf');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, 'x');
  F.releasePath(a);
  F.releasePath(b);
  assert.equal(path.basename(F.uniquePath(dir, '报价单.pdf')), '报价单 (2).pdf');
  assert.equal(path.basename(F.uniquePath(dir, 'noext')), 'noext');
  assert.equal(path.basename(F.uniquePath(dir, 'noext')), 'noext (1)');
});

test('下载：只有文档自动打开，可执行文件 / 脚本 / 网页绝不自动打开', () => {
  for (const e of ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt']) assert.ok(F.AUTO_OPEN_EXT.has(e), e);
  for (const e of ['exe', 'msi', 'bat', 'cmd', 'js', 'vbs', 'ps1', 'lnk', 'html', 'svg', 'docm', 'xlsm', 'jar', 'scr', 'hta', 'iso']) {
    assert.ok(F.DANGER_EXT.has(e), e);
    assert.ok(!F.AUTO_OPEN_EXT.has(e), e);
  }
  // 图片、音视频、压缩包：不自动打开，也不算危险（提示上可以手动点“打开”）
  for (const e of ['jpg', 'png', 'mp4', 'mp3', 'zip']) assert.ok(!F.AUTO_OPEN_EXT.has(e) && !F.DANGER_EXT.has(e), e);
  assert.equal(F.fileExt('C:\\\\Users\\\\a\\\\Downloads\\\\Setup.EXE'), 'exe');
  assert.equal(F.fileExt('/tmp/x/报价单.PDF'), 'pdf');
  assert.equal(F.fileExt('noext'), '');
});
