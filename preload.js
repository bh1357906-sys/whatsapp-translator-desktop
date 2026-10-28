const { ipcRenderer } = require('electron');

const cache = new Map();
const sentOriginals = new Map(); // 发送出去的译文 -> 原始中文

function injectStyles() {
  const css = `
  .wa-tr-line {
    display: block;
    margin: 3px 0 2px;
    padding: 6px 10px;
    font-size: 13px;
    line-height: 1.4;
    color: #667781;
    background: rgba(11, 20, 26, 0.04);
    border-left: 3px solid #00a884;
    border-radius: 0 8px 8px 0;
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 100%;
  }
  .dark .wa-tr-line { color: #aebac1; background: rgba(255,255,255,0.05); }
  .wa-tr-line.wa-tr-out {
    text-align: right;
    border-left: none;
    border-right: 3px solid #25d366;
    border-radius: 8px 0 0 8px;
  }
  #wa-tr-fab {
    position: fixed; right: 18px; bottom: 132px; z-index: 99999;
    width: 46px; height: 46px; border-radius: 50%;
    background: #00a884; color: #fff; font-size: 15px; font-weight: 700;
    border: none; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center;
  }
  #wa-tr-fab:hover { background: #008f72; }
  #wa-settings-fab {
    position: fixed; right: 18px; bottom: 188px; z-index: 99999;
    width: 46px; height: 46px; border-radius: 50%;
    background: #37474f; color: #fff; font-size: 18px;
    border: none; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center;
  }
  #wa-settings-fab:hover { background: #263238; }
  `;
  const st = document.createElement('style');
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);
}

// Real text message = the outer div that carries data-pre-plain-text
// (the inner span also has .copyable-text but no data-pre-plain-text).
function getMessageText(msgEl) {
  const ct = msgEl.querySelector('div.copyable-text[data-pre-plain-text]');
  if (!ct) return null;
  const sel = ct.querySelector('.selectable-text');
  const t = (sel ? sel.innerText : ct.innerText || '').trim();
  return t || null;
}

// 方向判断：连续消息只有最后一条有气泡尾巴(tail-out/tail-in)，
// 所以优先看 tail 图标，否则看 aria-label（收到的=对方名字，发出的="你："或"已送达"等）。
function isIncoming(msgEl) {
  if (msgEl.querySelector('span[data-icon="tail-in"]')) return true;
  if (msgEl.querySelector('span[data-icon="tail-out"]')) return false;
  const aria = (msgEl.querySelector('[aria-label]')?.getAttribute('aria-label') || '').trim();
  if (/^你[：:]/.test(aria) || /已送达|已读|已发送/.test(aria)) return false;
  return true;
}

function translateMessage(msgEl) {
  if (msgEl.dataset.waTr === 'pending' || msgEl.dataset.waTr === 'done') return;
  if (msgEl.querySelector('.wa-tr-line')) return;
  const text = getMessageText(msgEl);
  if (!text) return;
  const incoming = isIncoming(msgEl);
  const hasTailIn = !!msgEl.querySelector('span[data-icon="tail-in"]');
  msgEl.dataset.waTr = 'pending';
  const key = (msgEl.getAttribute('data-id') || '') + '::' + text;

  (async () => {
    let out = cache.get(key);
    if (out === undefined) {
      if (!incoming) {
        // 自己发的：优先用发送时缓存的原始中文，不必再调 API
        const orig = sentOriginals.get(text);
        if (orig !== undefined) out = orig;
      }
      if (out === undefined) {
        try {
          out = await ipcRenderer.invoke('translate', { text, direction: incoming ? 'incoming' : 'to-my-lang', latest: hasTailIn });
        } catch (err) {
          out =
            err && String(err.message).includes('NO_KEY')
              ? '⚠ 未配置 DeepSeek Key — 菜单 → 设置 填写后即可翻译'
              : '⚠ 翻译失败：' + (err && err.message ? String(err.message).slice(0, 80) : 'unknown');
        }
      }
      cache.set(key, out);
    }
    const line = document.createElement('div');
    line.className = 'wa-tr-line' + (incoming ? '' : ' wa-tr-out');
    line.textContent = out;
    msgEl.appendChild(line);
    msgEl.dataset.waTr = 'done';
  })();
}

function scan() {
  document.querySelectorAll('[data-testid^="conv-msg-"]').forEach(translateMessage);
}

function getInputBox() {
  return (
    document.querySelector('footer div[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"]')
  );
}

async function translateDraft() {
  const box = getInputBox();
  if (!box) return;
  const text = (box.innerText || '').trim();
  if (!text) return;
  try {
    const out = await ipcRenderer.invoke('translate', { text, direction: 'outgoing' });
    sentOriginals.set((out || '').trim(), text);
    box.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(box);
    sel.removeAllRanges();
    sel.addRange(r);
    await ipcRenderer.invoke('replace-draft', { text: out });
  } catch (err) {
    alert(
      err && String(err.message).includes('NO_KEY')
        ? '未配置 DeepSeek Key，请到菜单 → 设置 填写'
        : '翻译失败：' + (err && err.message ? String(err.message) : err)
    );
  }
}

function addFab() {
  const b = document.createElement('button');
  b.id = 'wa-tr-fab';
  b.textContent = '译';
  b.title = '翻译草稿为对方语言 (Alt+T)';
  b.addEventListener('click', translateDraft);
  document.body.appendChild(b);
}

function addSettingsFab() {
  const b = document.createElement('button');
  b.id = 'wa-settings-fab';
  b.textContent = '⚙';
  b.title = '设置（填 DeepSeek Key）';
  b.addEventListener('click', () => ipcRenderer.invoke('open-settings'));
  document.body.appendChild(b);
}

// 对方语言选择：手动选择，弹出滚动列表
const LANG_OPTIONS = [
  { name: 'English', code: 'EN' },
  { name: 'Armenian', code: 'HY' },
  { name: 'Hindi', code: 'HI' },
  { name: 'Spanish', code: 'ES' },
  { name: 'Arabic', code: 'AR' },
  { name: 'Portuguese', code: 'PT' },
  { name: 'Russian', code: 'RU' },
  { name: 'Japanese', code: 'JA' },
  { name: 'Korean', code: 'KO' },
  { name: 'French', code: 'FR' },
  { name: 'German', code: 'DE' },
  { name: 'Indonesian', code: 'ID' },
  { name: 'Simplified Chinese', code: '中' },
];
let currentLangName = null;

function addLangFab() {
  const b = document.createElement('button');
  b.id = 'wa-lang-fab';
  b.textContent = 'EN';
  b.title = '选择对方语言（点开列表选择）';
  b.style.cssText = 'position:fixed;right:18px;bottom:240px;z-index:99999;width:46px;height:46px;border-radius:50%;background:#6d3b8f;color:#fff;font-size:12px;font-weight:700;border:none;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,0.35);';

  // 语言面板（滚动列表）
  const panel = document.createElement('div');
  panel.id = 'wa-lang-panel';
  panel.style.cssText = 'position:fixed;right:18px;bottom:294px;z-index:99999;background:#fff;color:#111;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.35);max-height:340px;overflow-y:auto;width:210px;display:none;font-family:inherit;';
  LANG_OPTIONS.forEach((l) => {
    const item = document.createElement('div');
    item.textContent = l.name;
    item.style.cssText = 'padding:12px 16px;cursor:pointer;font-size:14px;border-bottom:1px solid #eee;';
    item.addEventListener('mouseenter', () => { item.style.background = '#f0f2f5'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', async () => {
      await ipcRenderer.invoke('set-their-lang', l.name);
      currentLangName = l.name;
      b.textContent = l.code;
      b.title = '对方语言：' + l.name + '（点开切换）';
      panel.style.display = 'none';
    });
    panel.appendChild(item);
  });
  document.body.appendChild(panel);

  b.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  document.body.appendChild(b);
}

let draftTranslating = false;
let swallowEnterKeyup = false;

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

async function translateAndSend(box) {
  try {
    const text = (box.innerText || '').trim();
    if (!text) return;
    const out = await ipcRenderer.invoke('translate', { text, direction: 'outgoing' });
    sentOriginals.set((out || '').trim(), text);
    box.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(box);
    sel.removeAllRanges();
    sel.addRange(r);
    await ipcRenderer.invoke('replace-draft', { text: out });
    await ipcRenderer.invoke('press-enter');
  } catch (err) {
    alert(
      err && String(err.message).includes('NO_KEY')
        ? '未配置 DeepSeek Key，请点 ⚙ 设置'
        : '翻译失败：' + (err && err.message ? String(err.message) : err)
    );
    try { await ipcRenderer.invoke('press-enter'); } catch (_) {}
  } finally {
    draftTranslating = false;
  }
}

function interceptSend() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.isComposing) return; // Shift+Enter 换行 / 输入法选词回车
    const box = getInputBox();
    if (!box || document.activeElement !== box) return;
    const text = (box.innerText || '').trim();
    if (!text || !hasChinese(text) || draftTranslating) return; // 非中文或翻译中，放行
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    swallowEnterKeyup = true;
    draftTranslating = true;
    translateAndSend(box);
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Enter' || !swallowEnterKeyup) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    swallowEnterKeyup = false;
  }, true);

  document.addEventListener('click', (e) => {
    const sendBtn = e.target && e.target.closest && e.target.closest('button[data-testid="send"], span[data-icon="send"], button[aria-label="发送"], button[aria-label="Send"]');
    if (!sendBtn) return;
    const box = getInputBox();
    const text = (box && box.innerText || '').trim();
    if (!text || !hasChinese(text) || draftTranslating) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    draftTranslating = true;
    translateAndSend(box);
  }, true);
}

function start() {
  injectStyles();
  addFab();
  addSettingsFab();
  addLangFab();
  scan();
  interceptSend();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
}

document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    translateDraft();
  }
});

if (document.body) start();
else document.addEventListener('DOMContentLoaded', start);
