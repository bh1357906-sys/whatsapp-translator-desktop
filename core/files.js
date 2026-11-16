// 下载文件的小工具：文件名清理、同名不覆盖、哪些类型可以自动打开（不依赖 Electron，方便单元测试）
'use strict';
const path = require('path');
const fs = require('fs');

// 文档类：存好后直接用系统默认程序打开（员工点 PDF / Word / Excel 就是想看内容）。
// 只列最常见的几种；其它类型（图片、压缩包、少见的文档格式……）不自动打开，提示上有“打开”按钮
const AUTO_OPEN_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt']);
// 危险类：可执行文件、脚本、带宏的文档、网页、磁盘镜像……只存不开，提示上也只给“打开文件夹”
const DANGER_EXT = new Set(['exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'hta', 'jar', 'lnk', 'url', 'reg', 'inf', 'dll', 'sys', 'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'html', 'htm', 'xhtml', 'mht', 'mhtml', 'svg', 'iso', 'img', 'vhd', 'vhdx', 'application', 'appref-ms', 'gadget', 'chm', 'hlp', 'sct', 'apk', 'appx', 'msix', 'sh', 'py', 'rb', 'pl', 'php', 'app', 'dmg', 'pkg', 'deb', 'rpm']);
const fileExt = (file) => path.extname(String(file || '')).slice(1).toLowerCase();
const MIME_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

// 文件名里去掉不能用的字符；没有扩展名的按文件类型补一个
function cleanFileName(name, mime) {
  let n = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!n) n = 'download';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  let ext = path.extname(n);
  if (!ext && MIME_EXT[String(mime || '').toLowerCase()]) {
    ext = '.' + MIME_EXT[String(mime).toLowerCase()];
    n += ext;
  }
  const base = n.slice(0, n.length - ext.length);
  if (base.length > 120) n = base.slice(0, 120) + ext;
  return n;
}

// 同名文件不覆盖：报价单.pdf → 报价单 (1).pdf
const reservedPaths = new Set();
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const p = path.join(dir, i ? base + ' (' + i + ')' + ext : name);
    if (!reservedPaths.has(p.toLowerCase()) && !fs.existsSync(p)) {
      reservedPaths.add(p.toLowerCase());
      return p;
    }
  }
  return path.join(dir, Date.now() + '-' + name);
}

// 下载结束（成功或失败）后把占用的名字放掉
function releasePath(p) {
  reservedPaths.delete(String(p || '').toLowerCase());
}

module.exports = { AUTO_OPEN_EXT, DANGER_EXT, MIME_EXT, fileExt, cleanFileName, uniquePath, releasePath };
