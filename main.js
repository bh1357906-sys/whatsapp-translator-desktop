const { app, BrowserWindow, ipcMain, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// WhatsApp Web may reject an Electron user agent; present a normal Chrome UA.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const defaultSettings = {
  engine: 'deepseek',
  apiBase: '',
  model: '',
  apiKey: '',
  myLang: 'Simplified Chinese',
  theirLang: 'English',
};

const ENGINE_PRESETS = {
  deepseek: { apiBase: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { apiBase: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  gemini: { apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...defaultSettings };
  }
}
function saveSettings(s) {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 850,
    title: 'WA Translator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL('https://web.whatsapp.com/', { userAgent: CHROME_UA });
  return win;
}

function openSettings() {
  const win = new BrowserWindow({
    width: 480,
    height: 600,
    title: '设置 - WA Translator',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('settings.html');
}

app.whenReady().then(() => {
  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '设置…', accelerator: 'CmdOrCtrl+,', click: openSettings },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
  Menu.setApplicationMenu(menu);

  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('open-settings', () => {
  openSettings();
  return true;
});
ipcMain.handle('replace-draft', async (e, { text }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return true;
  clipboard.writeText(text);
  await win.webContents.executeJavaScript(`
    (function() {
      const box = document.querySelector('footer div[contenteditable="true"]');
      if (!box) return false;
      box.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })()
  `);
  win.webContents.paste();
  return true;
});
ipcMain.handle('press-enter', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return true;
  await win.webContents.executeJavaScript(`
    (function() {
      const btn = document.querySelector('button[aria-label="发送"], button[aria-label="Send"], button[data-testid="send"], span[data-icon="send"]');
      if (btn) btn.click();
    })()
  `);
  return true;
});
ipcMain.handle('set-settings', (e, s) => {
  const merged = { ...defaultSettings, ...s };
  saveSettings(merged);
  return true;
});
ipcMain.handle('set-their-lang', (e, lang) => {
  currentTheirLang = lang || null;
  return currentTheirLang;
});
ipcMain.handle('get-their-lang', () => currentTheirLang);

let currentTheirLang = null; // 用户手动选择的对方语言，由界面按钮设置（不再自动检测）

async function callDeepSeek(s, prompt) {
  const preset = ENGINE_PRESETS[s.engine] || ENGINE_PRESETS.deepseek;
  const apiBase = s.apiBase || preset.apiBase;
  const model = s.model || preset.model;
  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

ipcMain.handle('translate', async (e, { text, direction, latest }) => {
  const s = loadSettings();
  if (!s.apiKey) throw new Error('NO_KEY');

  if (direction === 'incoming') {
    const prompt = [
      `Translate the following WhatsApp message into natural, idiomatic ${s.myLang} — like a native speaker chatting, not a literal word-for-word translation.`,
      'Preserve tone, emojis and line breaks.',
      'Do not add quotes, notes or explanations. Output only the translation.',
      '',
      text,
    ].join('\n');
    return await callDeepSeek(s, prompt);
  }

  if (direction === 'to-my-lang') {
    // 自己消息显示中文：只翻译，不检测源语言、不更新对方语言
    const prompt = [
      `Translate the following WhatsApp message into natural, idiomatic ${s.myLang} — like a native speaker chatting, not a literal word-for-word translation.`,
      'Preserve tone, emojis and line breaks.',
      'Do not add quotes, notes or explanations. Output only the translation.',
      '',
      text,
    ].join('\n');
    return await callDeepSeek(s, prompt);
  }

  // outgoing: translate into the user-selected language (manual, not auto-detected)
  const target = currentTheirLang || s.theirLang;
  const prompt = [
    `Translate the following WhatsApp message into natural, idiomatic ${target} — like a native speaker chatting, not a literal word-for-word translation.`,
    'Keep it casual and conversational (this is WhatsApp chat, not formal writing).',
    'First fix any typos, wrong characters or missing characters in the message.',
    'Preserve tone, emojis, line breaks and punctuation.',
    'Do not add quotes, notes or explanations. Output only the translation.',
    '',
    text,
  ].join('\n');
  const out = await callDeepSeek(s, prompt);
  return out;
});
