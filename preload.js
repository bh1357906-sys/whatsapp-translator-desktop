const { ipcRenderer } = require('electron');

const cache = new Map();
const sentOriginals = new Map(); // 发送出去的译文 -> 原始中文

// ---- Wingman：聊天记忆 + 实时建议 ----
const recentMsgs = []; // [{role:'me'|'her', text}]
const loggedIds = new Set();
let currentChat = null;
let wingmanTarget = '';
let relationType = 'dating';
const RELATION_MODES = [
  { key: 'dating', short: '追', title: '追女生' },
  { key: 'friend', short: '友', title: '普通朋友' },
  { key: 'business', short: '商', title: '商务' },
];
let userInstruction = '';

function normalizeContact(s) {
  return String(s || '').toLowerCase().replace(/[\s\-()\.]/g, '');
}
function isTargetChat() {
  if (!wingmanTarget) return false;
  const name = currentChatName();
  if (name && normalizeContact(name) === normalizeContact(wingmanTarget)) return true;
  const num = currentChatNumber();
  const tDigits = normalizeDigits(wingmanTarget);
  if (tDigits && num && normalizeDigits(num) === tDigits) return true;
  return false;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STATUS_WORDS = /^(在线|正在输入|输入中|打字中|online|typing|离线|last seen|个人主页详情|个人信息|点击此处查看联系人信息|查看联系人信息|点击查看联系人)$/i;
function currentChatName() {
  try {
    const h = document.querySelector('[data-testid="conversation-header"]');
    if (!h) return null;
    const lines = (h.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s && !STATUS_WORDS.test(s));
    return lines.length ? lines[lines.length - 1] : null;
  } catch (_) { return null; }
}

function normalizeDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

function currentChatNumber() {
  try {
    const panel = document.querySelector('[data-testid="conversation-panel-wrapper"]') || document.body;
    const els = panel.querySelectorAll('span, div');
    for (const el of els) {
      if (el.childElementCount !== 0) continue;
      const t = (el.textContent || '').trim();
      if (/^\+?\d[\d\s()\-]{5,}$/.test(t) && t.length <= 20) return t;
    }
    return null;
  } catch (_) { return null; }
}

function maybeResetChat() {
  const name = currentChatName();
  if (name && name !== currentChat) {
    currentChat = name;
    recentMsgs.length = 0;
    loggedIds.clear();
    applyContactLang(name); // 切换聊天时，应用该联系人上次用的语言
  }
}

async function applyContactLang(name) {
  try {
    const lang = await ipcRenderer.invoke('get-contact-lang', name);
    if (lang) {
      currentLangName = lang;
      const opt = LANG_OPTIONS.find((l) => l.name === lang);
      const b = document.getElementById('wa-lang-fab');
      if (b && opt) { b.textContent = opt.code; b.title = '对方语言：' + opt.name + '（点开切换）'; }
    }
  } catch (_) {}
}

function captureMessage(msgEl, text, incoming) {
  if (!isTargetChat()) return;
  const id = msgEl.getAttribute('data-id') || (incoming ? 'in:' : 'out:') + text;
  if (loggedIds.has(id)) return;
  loggedIds.add(id);
  const entry = { id, role: incoming ? 'her' : 'me', text, chat: currentChat || '' };
  recentMsgs.push(entry);
  if (recentMsgs.length > 60) recentMsgs.shift();
  if (incoming) showHerBadge();
  ipcRenderer.invoke('wingman-log', entry).catch(() => {});
}

function rescanCurrentChat() {
  recentMsgs.length = 0;
  loggedIds.clear();
  document.querySelectorAll('[data-testid^="conv-msg-"]').forEach((el) => {
    const text = getMessageText(el);
    if (!text) return;
    captureMessage(el, text, isIncoming(el));
  });
}

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
  // 克隆并移除引用块，只取正文（否则引用消息会提取到被引用的旧内容）
  const clone = ct.cloneNode(true);
  const quote = clone.querySelector('[data-testid="quoted-message"]');
  if (quote) quote.remove();
  const sel = clone.querySelector('.selectable-text');
  const t = (sel ? sel.innerText : clone.innerText || '').trim();
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
  maybeResetChat();
  captureMessage(msgEl, text, incoming);
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
      await ipcRenderer.invoke('set-their-lang', { lang: l.name, contact: currentChatName() || '' });
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
    const clean = (out || '').trim();
    // 兜底检查：译文为空或仍含中文（翻译异常），不发原文，保留草稿
    if (!clean || hasChinese(clean)) {
      alert('翻译结果异常（未得到目标语言），消息未发送，请重试');
      return;
    }
    sentOriginals.set(clean, text);
    await ipcRenderer.invoke('replace-draft', { text: clean });
    await ipcRenderer.invoke('press-enter');
  } catch (err) {
    // 翻译失败：不发原文（避免中文直接发给外国客户），保留草稿让用户重试
    alert(
      err && String(err.message).includes('NO_KEY')
        ? '未配置 DeepSeek Key，请点 ⚙ 设置'
        : '翻译失败：' + (err && err.message ? String(err.message) : err) + '\n\n（消息未发送，可重试）'
    );
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

function addWingmanFab() {
  const b = document.createElement('button');
  b.id = 'wa-wing-fab';
  b.textContent = '💬';
  b.title = '聊天建议：分析目标号码的态度 + 拟几条回复（点候选回复填入输入框，自己发送）';
  b.style.cssText =
    'position:fixed;right:18px;bottom:292px;z-index:99999;width:46px;height:46px;border-radius:50%;background:#d43f81;color:#fff;font-size:18px;border:none;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,0.35);';
  document.body.appendChild(b);

  const panel = document.createElement('div');
  panel.id = 'wa-wing-panel';
  panel.style.cssText =
    'position:fixed;right:18px;bottom:348px;z-index:99999;background:#fff;color:#111;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.4);width:280px;max-height:56vh;overflow-y:auto;padding:12px;display:none;font-family:inherit;';
  document.body.appendChild(panel);

  // 顶栏：目标 + 设置（紧凑，输入框默认收起）
  const top = document.createElement('div');
  top.style.cssText = 'margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee;';
  const labelRow = document.createElement('div');
  labelRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;';
  const targetLabel = document.createElement('div');
  targetLabel.style.cssText = 'font-size:13px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const setBtn = document.createElement('button');
  setBtn.textContent = '设置';
  setBtn.style.cssText = 'flex:0 0 auto;padding:2px 8px;background:#f0f2f5;color:#333;border:1px solid #ccc;border-radius:5px;cursor:pointer;font-size:12px;';
  const curBtn = document.createElement('button');
  curBtn.textContent = '当前';
  curBtn.title = '把当前打开的聊天设为目标';
  curBtn.style.cssText = 'flex:0 0 auto;padding:2px 8px;background:#d43f81;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px;';
  const profileBtn = document.createElement('button');
  profileBtn.textContent = '档案';
  profileBtn.title = '导入聊天记录，生成人物档案';
  profileBtn.style.cssText = 'flex:0 0 auto;padding:2px 8px;background:#f0f2f5;color:#333;border:1px solid #ccc;border-radius:5px;cursor:pointer;font-size:12px;';
  const reviewBtn = document.createElement('button');
  reviewBtn.textContent = '复盘';
  reviewBtn.title = '复盘这一段对话：做得好/要改/下一步';
  reviewBtn.style.cssText = 'flex:0 0 auto;padding:2px 8px;background:#f0f2f5;color:#333;border:1px solid #ccc;border-radius:5px;cursor:pointer;font-size:12px;';
  const modeBtn = document.createElement('button');
  modeBtn.title = '关系类型：追女生/普通朋友/商务（点击切换）';
  modeBtn.style.cssText = 'flex:0 0 auto;padding:2px 6px;background:#6d3b8f;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;';
  const updateModeBtn = () => {
    const m = RELATION_MODES.find((x) => x.key === relationType) || RELATION_MODES[0];
    modeBtn.textContent = m.short;
    modeBtn.title = '关系类型：' + m.title + '（点击切换）';
  };
  updateModeBtn();
  modeBtn.addEventListener('click', async () => {
    const idx = RELATION_MODES.findIndex((x) => x.key === relationType);
    relationType = RELATION_MODES[(idx + 1) % RELATION_MODES.length].key;
    await ipcRenderer.invoke('set-relation-type', relationType);
    updateModeBtn();
  });
  labelRow.appendChild(targetLabel);
  labelRow.appendChild(curBtn);
  labelRow.appendChild(setBtn);
  labelRow.appendChild(profileBtn);
  labelRow.appendChild(reviewBtn);
  labelRow.appendChild(modeBtn);
  const setRow = document.createElement('div');
  setRow.style.cssText = 'margin-top:6px;display:none;';
  const targetInput = document.createElement('input');
  targetInput.placeholder = '目标号码 / 联系人';
  targetInput.value = wingmanTarget;
  targetInput.style.cssText = 'width:calc(100% - 60px);padding:6px;border:1px solid #ccc;border-radius:6px;font-size:12px;box-sizing:border-box;';
  const targetBtn = document.createElement('button');
  targetBtn.textContent = '保存';
  targetBtn.style.cssText = 'margin-left:4px;padding:6px 8px;background:#d43f81;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;';
  setRow.appendChild(targetInput);
  setRow.appendChild(targetBtn);
  const updateLabel = () => {
    targetLabel.innerHTML = '<span style="color:#667781;">目标：</span>' + (wingmanTarget ? escapeHtml(wingmanTarget) : '<span style="color:#d32f2f;">未设置（不记录）</span>');
  };
  updateLabel();
  setBtn.addEventListener('click', () => {
    setRow.style.display = setRow.style.display === 'none' ? 'block' : 'none';
  });
  curBtn.addEventListener('click', async () => {
    const name = currentChatName();
    if (!name) { alert('请先打开要设为目标的那个聊天'); return; }
    wingmanTarget = name;
    await ipcRenderer.invoke('set-wingman-target', name);
    targetInput.value = name;
    updateLabel();
    rescanCurrentChat();
    runSuggest(body);
  });
  targetBtn.addEventListener('click', async () => {
    wingmanTarget = (targetInput.value || '').trim();
    await ipcRenderer.invoke('set-wingman-target', wingmanTarget);
    targetInput.value = wingmanTarget;
    setRow.style.display = 'none';
    updateLabel();
    rescanCurrentChat();
    runSuggest(body);
  });
  top.appendChild(labelRow);
  top.appendChild(setRow);
  panel.appendChild(top);

  // 要求输入框（常驻）
  const instructRow = document.createElement('div');
  instructRow.style.cssText = 'margin-bottom:8px;';
  const instructInput = document.createElement('input');
  instructInput.id = 'wa-instruct';
  instructInput.placeholder = '要求（可选）：简短点 / 幽默点 / 别太主动…';
  instructInput.value = userInstruction;
  instructInput.style.cssText = 'width:100%;padding:6px;border:1px solid #ccc;border-radius:6px;font-size:12px;box-sizing:border-box;';
  instructRow.appendChild(instructInput);
  panel.appendChild(instructRow);
  instructInput.addEventListener('change', async () => {
    userInstruction = instructInput.value.trim();
    await ipcRenderer.invoke('set-instruction', userInstruction);
    if (wingmanTarget && isTargetChat()) runSuggest(body, false);
  });

  // 人物档案区（默认收起）
  const profileSection = document.createElement('div');
  profileSection.style.cssText = 'margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee;display:none;';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.txt,text/plain';
  fileInput.style.display = 'none';
  const importBtn = document.createElement('button');
  importBtn.textContent = '导入聊天记录';
  importBtn.style.cssText = 'padding:6px 10px;background:#d43f81;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;';
  const profileDisplay = document.createElement('div');
  profileDisplay.style.cssText = 'margin-top:8px;font-size:12px;color:#333;line-height:1.5;max-height:40vh;overflow-y:auto;';
  profileSection.appendChild(fileInput);
  profileSection.appendChild(importBtn);
  profileSection.appendChild(profileDisplay);
  panel.appendChild(profileSection);

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!wingmanTarget) { profileDisplay.innerHTML = '<span style="color:#d32f2f;">请先设置目标（点「当前」或「设置」）</span>'; return; }
    profileDisplay.innerHTML = '<div style="color:#667781;">正在通读聊天记录、生成档案…（可能要十几秒）</div>';
    try {
      const text = await file.text();
      const res = await ipcRenderer.invoke('wingman-build-profile', { target: wingmanTarget, text });
      renderProfile(profileDisplay, res);
    } catch (err) {
      profileDisplay.innerHTML = '<div style="color:#c00;white-space:pre-wrap;">' +
        (String(err.message).includes('NO_KEY') ? '未配置 DeepSeek Key（点 ⚙ 设置）' : '生成失败：' + String(err.message).slice(0, 200)) + '</div>';
    }
  });
  profileBtn.addEventListener('click', async () => {
    const show = profileSection.style.display === 'none';
    profileSection.style.display = show ? 'block' : 'none';
    if (show) {
      if (wingmanTarget) {
        const p = await ipcRenderer.invoke('wingman-get-profile', wingmanTarget);
        renderProfile(profileDisplay, p);
      } else {
        profileDisplay.innerHTML = '<div style="color:#667781;">先设置目标，再导入记录生成档案。</div>';
      }
    }
  });
  reviewBtn.addEventListener('click', async () => {
    if (!wingmanTarget) { body.innerHTML = '<div style="padding:16px;color:#667781;text-align:center;">先设置目标。</div>'; return; }
    body.innerHTML = '<div style="padding:16px;color:#667781;text-align:center;">复盘分析中…</div>';
    try {
      const res = await ipcRenderer.invoke('wingman-review', { targetName: wingmanTarget, messages: recentMsgs.slice(-40).map((m) => ({ role: m.role, text: m.text })) });
      renderReview(body, res);
    } catch (err) {
      body.innerHTML = '<div style="padding:16px;color:#c00;white-space:pre-wrap;">' +
        (String(err.message).includes('NO_KEY') ? '未配置 DeepSeek Key（点 ⚙ 设置）' : '复盘失败：' + String(err.message).slice(0, 200)) + '</div>';
    }
  });

  const body = document.createElement('div');
  panel.appendChild(body);

  b.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    if (open) { clearHerBadge(); runSuggest(body); }
  });

  ipcRenderer.invoke('get-settings').then((s) => {
    wingmanTarget = (s && s.wingmanTarget) || '';
    targetInput.value = wingmanTarget;
    updateLabel();
    relationType = (s && s.relationType) || 'dating';
    updateModeBtn();
    userInstruction = (s && s.wingmanInstruction) || '';
    instructInput.value = userInstruction;
    scan();
  }).catch(() => {});
}

async function runSuggest(body, vary) {
  if (!wingmanTarget) {
    body.innerHTML = '<div style="padding:16px;color:#667781;text-align:center;">先点上面「设置」填目标号码。未设置前不记录、不分析任何聊天。</div>';
    return;
  }
  if (!isTargetChat()) {
    body.innerHTML = '<div style="padding:16px;color:#667781;text-align:center;">当前聊天不是目标（' + escapeHtml(wingmanTarget) + '）。请打开目标号码的聊天再点 💬。</div>';
    return;
  }
  body.innerHTML = '<div style="padding:16px;color:#667781;text-align:center;">分析中…</div>';
  const msgs = recentMsgs.slice(-25).map((m) => ({ role: m.role, text: m.text }));
  if (msgs.length === 0) {
    body.innerHTML = '<div style="padding:16px;color:#667781;text-align:center;">当前聊天还没有消息，先聊几句再点。</div>';
    return;
  }
  try {
    const instrEl = document.getElementById('wa-instruct');
    const instruction = instrEl ? instrEl.value.trim() : userInstruction;
    if (instruction !== userInstruction) {
      userInstruction = instruction;
      ipcRenderer.invoke('set-instruction', instruction).catch(() => {});
    }
    const res = await ipcRenderer.invoke('wingman-suggest', {
      messages: msgs,
      theirLang: currentLangName || null,
      myLang: 'Simplified Chinese',
      targetName: wingmanTarget,
      vary: !!vary,
      instruction,
    });
    renderSuggest(body, res);
  } catch (err) {
    body.innerHTML =
      '<div style="padding:16px;color:#c00;white-space:pre-wrap;">' +
      (String(err.message).includes('NO_KEY')
        ? '未配置 DeepSeek Key（点 ⚙ 设置）'
        : '分析失败：' + String(err.message).slice(0, 200)) +
      '</div>';
  }
}

function renderProfile(el, p) {
  if (!p) {
    el.innerHTML = '<div style="color:#667781;">还没有档案。点「导入聊天记录」，选择导出的 txt 生成。</div>';
    return;
  }
  const labels = {
    summary: '概括',
    personality: '性格',
    interests: '兴趣',
    habits: '生活习惯',
    communication: '沟通风格',
    topicsLikes: '喜欢的话题',
    topicsAvoid: '回避的话题',
    attitudeTowardYou: '对你的态度',
    notes: '注意事项',
  };
  let html = '';
  Object.keys(labels).forEach((k) => {
    if (p[k]) html += '<div style="margin-bottom:6px;"><b>' + labels[k] + '：</b>' + escapeHtml(p[k]) + '</div>';
  });
  el.innerHTML = html || '<div style="color:#667781;">档案为空。</div>';
}

let herBadge = null;
function showHerBadge() {
  const fab = document.getElementById('wa-wing-fab');
  if (!fab || herBadge) return;
  herBadge = document.createElement('div');
  herBadge.style.cssText = 'position:absolute;top:-3px;right:-3px;width:14px;height:14px;border-radius:50%;background:#f00;border:2px solid #fff;';
  fab.appendChild(herBadge);
}
function clearHerBadge() {
  if (herBadge) { herBadge.remove(); herBadge = null; }
}

function renderReview(body, res) {
  let html = '<div style="font-size:14px;font-weight:700;margin-bottom:8px;">复盘</div>';
  if (res.good) html += '<div style="font-size:13px;color:#2e7d32;margin-bottom:6px;line-height:1.5;"><b>做得好：</b>' + escapeHtml(res.good) + '</div>';
  if (res.bad) html += '<div style="font-size:13px;color:#c62828;margin-bottom:6px;line-height:1.5;"><b>要改：</b>' + escapeHtml(res.bad) + '</div>';
  if (res.next) html += '<div style="font-size:13px;color:#333;background:#fff8e1;padding:8px;border-radius:8px;line-height:1.5;"><b>下一步：</b>' + escapeHtml(res.next) + '</div>';
  body.innerHTML = html;
}

function renderSuggest(body, res) {
  const isDating = res.interest !== undefined;
  let html = '';
  if (isDating) {
    const interestColor = { low: '#d32f2f', medium: '#f59e0b', high: '#2e7d32' }[res.interest] || '#999';
    const interestLabel = { low: '低', medium: '中', high: '高' }[res.interest] || res.interest;
    const trendLabel = { rising: '上升', stable: '平稳', falling: '下降' }[res.trend] || '';
    html += '<div style="margin-bottom:10px;">';
    html += '<div style="font-size:15px;font-weight:700;">热度：<span style="color:' + interestColor + ';">' + escapeHtml(interestLabel) + '</span>' + (trendLabel ? ' <span style="font-size:12px;color:#667781;font-weight:400;">（' + escapeHtml(trendLabel) + '）</span>' : '') + '</div>';
    if (res.stage) html += '<div style="font-size:12px;color:#667781;margin-top:2px;">阶段：' + escapeHtml(res.stage) + '</div>';
    html += '<div style="font-size:13px;color:#333;margin:8px 0;line-height:1.5;">' + escapeHtml(res.read || '') + '</div>';
    html += '</div>';
  } else if (res.tone) {
    html += '<div style="font-size:13px;color:#333;margin-bottom:8px;line-height:1.5;">' + escapeHtml(res.tone) + '</div>';
  }
  html += '<div style="font-size:14px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;"><span>可选回复（点一下填入输入框）</span><button id="wa-refresh-btn" style="font-size:12px;padding:3px 10px;background:#f0f2f5;color:#333;border:1px solid #ccc;border-radius:5px;cursor:pointer;">🔄 换一批</button></div>';
  (res.replies || []).forEach((r) => {
    const text = typeof r === 'string' ? r : r.text;
    const zh = typeof r === 'string' ? '' : r.zh || '';
    html += '<div class="wa-wing-reply" data-text="' + escapeAttr(text) + '" style="padding:10px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;cursor:pointer;background:#f7f9fa;">';
    html += '<div style="font-size:14px;color:#111;">' + escapeHtml(text) + '</div>';
    if (zh) html += '<div style="font-size:12px;color:#667781;margin-top:4px;">' + escapeHtml(zh) + '</div>';
    html += '</div>';
  });
  if (res.advice) html += '<div style="font-size:13px;color:#333;margin-top:6px;background:#fff8e1;padding:8px;border-radius:8px;line-height:1.5;">' + escapeHtml(res.advice) + '</div>';
  if (res.cadence) html += '<div style="font-size:13px;color:#333;margin-top:6px;background:#e8f5e9;padding:8px;border-radius:8px;line-height:1.5;">' + escapeHtml(res.cadence) + '</div>';
  body.innerHTML = html;
  const rf = body.querySelector('#wa-refresh-btn');
  if (rf) rf.addEventListener('click', () => runSuggest(body, true));
  body.querySelectorAll('.wa-wing-reply').forEach((el) => {
    el.addEventListener('click', async () => {
      await ipcRenderer.invoke('replace-draft', { text: el.dataset.text });
      const p = document.getElementById('wa-wing-panel');
      if (p) p.style.display = 'none';
    });
  });
}

function start() {
  injectStyles();
  addFab();
  addSettingsFab();
  addLangFab();
  addWingmanFab();
  scan();
  interceptSend();
  // MutationObserver 节流：DOM 高频变化时最多每 300ms 扫描一次，避免 CPU 飙升
  let scanTimer = null;
  const throttledScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 300);
  };
  new MutationObserver(throttledScan).observe(document.body, { childList: true, subtree: true });
  // 语言选择持久化：启动时从设置读回
  ipcRenderer.invoke('get-settings').then((s) => {
    if (s && s.theirLang) {
      currentLangName = s.theirLang;
      const opt = LANG_OPTIONS.find((l) => l.name === s.theirLang);
      const b = document.getElementById('wa-lang-fab');
      if (b && opt) { b.textContent = opt.code; b.title = '对方语言：' + opt.name + '（点开切换）'; }
    }
  }).catch(() => {});
}

document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    translateDraft();
  }
});

if (document.body) start();
else document.addEventListener('DOMContentLoaded', start);
