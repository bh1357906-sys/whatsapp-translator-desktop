'use strict';
const api = window.settingsApi;
const $ = (id) => document.getElementById(id);

let data = null;
const keys = {}; // 各引擎的 key（编辑中）

function fillSelect(sel, items, value) {
  sel.innerHTML = '';
  items.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  });
  sel.value = value;
}

function showEngine() {
  const e = $('engine').value;
  const preset = data.engines[e] || {};
  $('apiKey').value = keys[e] || '';
  $('apiBase').placeholder = preset.apiBase || 'https://your-endpoint/v1';
  $('model').placeholder = preset.model || '模型名';
  if (e === 'custom') $('adv').open = true;
}

function sttKeyName() {
  const p = (data.sttEngines || {})[$('sttEngine').value] || {};
  return p.keyName || 'stt_' + $('sttEngine').value;
}

function showStt() {
  const e = $('sttEngine').value;
  const preset = (data.sttEngines || {})[e] || {};
  $('sttKey').value = keys[sttKeyName()] || '';
  $('sttApiBase').placeholder = preset.apiBase || 'https://your-endpoint/v1';
  $('sttModel').placeholder = preset.model || '模型名';
  if (e === 'custom') $('sttAdv').open = true;
}

// 翻译和语音都选 OpenAI 时，两个 Key 输入框是同一个 Key，保持同步
function syncSharedKey(from) {
  if (sttKeyName() !== $('engine').value) return;
  if (from === 'stt') $('apiKey').value = $('sttKey').value;
  else $('sttKey').value = $('apiKey').value;
}

function status(msg, cls) {
  const st = $('status');
  st.textContent = msg;
  st.className = cls || '';
}

function collect() {
  keys[$('engine').value] = $('apiKey').value.trim();
  if (data.sttEngines) keys[sttKeyName()] = $('sttKey').value.trim();
  return {
    engine: $('engine').value,
    apiKeys: { ...keys },
    apiBase: $('apiBase').value.trim(),
    model: $('model').value.trim(),
    myLang: $('myLang').value,
    defaultTheirLang: $('defaultTheirLang').value,
    autoTranslateIncoming: $('autoTranslateIncoming').checked,
    showOwnTranslation: $('showOwnTranslation').checked,
    autoTranslateSend: $('autoTranslateSend').checked,
    previewBeforeSend: $('previewBeforeSend').checked,
    autoDetectLang: $('autoDetectLang').checked,
    useContext: $('useContext').checked,
    glossary: $('glossary').value,
    sttEngine: $('sttEngine').value,
    sttApiBase: $('sttApiBase').value.trim(),
    sttModel: $('sttModel').value.trim(),
    voiceTranslate: $('voiceTranslate').checked,
    voiceAutoOnPlay: $('voiceAutoOnPlay').checked,
    voiceAutoTranslate: $('voiceAutoTranslate').checked,
  };
}

(async () => {
  data = await api.get();
  const s = data.settings;
  document.title = '设置 - ' + data.appName;
  $('title').textContent = data.appName + ' 设置';
  $('ver').textContent = '版本 ' + data.version;
  Object.assign(keys, s.apiKeys || {});
  fillSelect($('engine'), Object.entries(data.engines).map(([k, v]) => [k, v.label]), s.engine);
  const langs = data.languages.map((l) => [l.name, l.label || l.name]);
  fillSelect($('myLang'), langs, s.myLang);
  fillSelect($('defaultTheirLang'), langs, s.defaultTheirLang);
  $('apiBase').value = s.apiBase || '';
  $('model').value = s.model || '';
  if (s.apiBase || s.model) $('adv').open = true;
  $('autoTranslateIncoming').checked = !!s.autoTranslateIncoming;
  $('showOwnTranslation').checked = !!s.showOwnTranslation;
  $('autoTranslateSend').checked = !!s.autoTranslateSend;
  $('previewBeforeSend').checked = !!s.previewBeforeSend;
  $('autoDetectLang').checked = s.autoDetectLang !== false;
  $('useContext').checked = s.useContext !== false;
  $('glossary').value = s.glossary || '';
  showEngine();
  if (data.sttEngines) {
    fillSelect($('sttEngine'), Object.entries(data.sttEngines).map(([k, v]) => [k, v.label]), s.sttEngine || 'groq');
    $('sttApiBase').value = s.sttApiBase || '';
    $('sttModel').value = s.sttModel || '';
    if (s.sttApiBase || s.sttModel) $('sttAdv').open = true;
    showStt();
  }
  $('voiceTranslate').checked = s.voiceTranslate !== false;
  $('voiceAutoOnPlay').checked = s.voiceAutoOnPlay !== false;
  $('voiceAutoTranslate').checked = s.voiceAutoTranslate !== false;
  if (data.encrypted) $('keyhint').textContent += ' 已用系统加密保存。';
  if (!data.canUpdate) $('checkUpdate').style.display = 'none';
  const u = data.usage;
  if (u) {
    const f = (x) => x.requests + ' 次请求 · ' + x.tokens.toLocaleString() + ' tokens · ' + x.chars.toLocaleString() + ' 字';
    $('usage').innerHTML = '';
    const a = document.createElement('div');
    a.textContent = '今天：' + f(u.today);
    const b = document.createElement('div');
    b.textContent = '本月（' + u.monthLabel + '）：' + f(u.month);
    $('usage').append(a, b);
  }
})();

let lastEngine = null;
$('engine').addEventListener('focus', () => (lastEngine = $('engine').value));
$('engine').addEventListener('change', () => {
  if (lastEngine) keys[lastEngine] = $('apiKey').value.trim();
  lastEngine = $('engine').value;
  // 切换引擎时，自定义地址/模型通常不再适用
  if ($('engine').value !== 'custom') {
    $('apiBase').value = '';
    $('model').value = '';
  }
  showEngine();
});

let lastStt = null;
$('sttEngine').addEventListener('focus', () => (lastStt = sttKeyName()));
$('sttEngine').addEventListener('change', () => {
  if (lastStt) keys[lastStt] = $('sttKey').value.trim();
  lastStt = sttKeyName();
  if ($('sttEngine').value !== 'custom') {
    $('sttApiBase').value = '';
    $('sttModel').value = '';
  }
  showStt();
});
$('sttKey').addEventListener('input', () => syncSharedKey('stt'));
$('apiKey').addEventListener('input', () => syncSharedKey('tr'));

$('testStt').addEventListener('click', async () => {
  status('测试语音识别中…');
  try {
    const model = await api.testStt(collect());
    status('语音识别可用 ✓（模型：' + model + '）', 'ok');
  } catch (err) {
    status('语音识别测试失败：' + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace('NO_STT_KEY', '没有填语音识别的 Key'), 'err');
  }
});

$('test').addEventListener('click', async () => {
  status('测试中…');
  try {
    const out = await api.test(collect());
    status('连接成功 ✓  测试译文：' + out, 'ok');
  } catch (err) {
    status('连接失败：' + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace('NO_KEY', '没有填 API Key'), 'err');
  }
});

$('save').addEventListener('click', async () => {
  try {
    await api.set(collect());
    status('已保存 ✓', 'ok');
    setTimeout(() => window.close(), 600);
  } catch (err) {
    status('保存失败：' + err.message, 'err');
  }
});

$('checkUpdate').addEventListener('click', () => api.checkUpdate());
