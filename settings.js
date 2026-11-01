'use strict';
const api = window.settingsApi;
const $ = (id) => document.getElementById(id);
const I18N = window.TRX_I18N;
const T = I18N.T;

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
  $('model').placeholder = preset.model || T('模型名');
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
  $('sttModel').placeholder = preset.model || T('模型名');
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
    uiLang: $('uiLang').value,
    sttEngine: $('sttEngine').value,
    sttApiBase: $('sttApiBase').value.trim(),
    sttModel: $('sttModel').value.trim(),
    voiceTranslate: $('voiceTranslate').checked,
    voiceAutoOnPlay: $('voiceAutoOnPlay').checked,
    voiceAutoTranslate: $('voiceAutoTranslate').checked,
  };
}

// 界面语言：静态文字用词典替换，下拉框重新填
function applyUiLang(l, s) {
  I18N.setLang(l);
  I18N.localizeDom(document.body);
  const cur = s || { engine: $('engine').value, myLang: $('myLang').value, defaultTheirLang: $('defaultTheirLang').value, sttEngine: $('sttEngine').value };
  fillSelect($('engine'), Object.entries(data.engines).map(([k, v]) => [k, T(v.label)]), cur.engine);
  const langs = data.languages.map((l2) => [l2.name, l === 'en' ? l2.name : l2.label || l2.name]);
  fillSelect($('myLang'), langs, cur.myLang);
  fillSelect($('defaultTheirLang'), langs, cur.defaultTheirLang);
  if (data.sttEngines) fillSelect($('sttEngine'), Object.entries(data.sttEngines).map(([k, v]) => [k, T(v.label)]), cur.sttEngine || 'groq');
  document.title = T('设置 - ') + data.appName;
  $('title').textContent = data.appName + T(' 设置');
  $('ver').textContent = T('版本 ') + data.version;
  showUsage();
}

function showUsage() {
  const u = data && data.usage;
  if (!u) return;
  const f = (x) => T('{0} 次请求 · {1} tokens · {2} 字', x.requests, x.tokens.toLocaleString(), x.chars.toLocaleString());
  $('usage').innerHTML = '';
  const a = document.createElement('div');
  a.textContent = T('今天：') + f(u.today);
  const b = document.createElement('div');
  b.textContent = T('本月（{0}）：', u.monthLabel) + f(u.month);
  $('usage').append(a, b);
}

(async () => {
  data = await api.get();
  const s = data.settings;
  Object.assign(keys, s.apiKeys || {});
  $('uiLang').value = s.uiLang === 'en' ? 'en' : 'zh';
  applyUiLang($('uiLang').value, s);
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
    $('sttApiBase').value = s.sttApiBase || '';
    $('sttModel').value = s.sttModel || '';
    if (s.sttApiBase || s.sttModel) $('sttAdv').open = true;
    showStt();
  }
  $('voiceTranslate').checked = s.voiceTranslate !== false;
  $('voiceAutoOnPlay').checked = s.voiceAutoOnPlay !== false;
  $('voiceAutoTranslate').checked = s.voiceAutoTranslate !== false;
  if (data.encrypted) $('encNote').style.display = '';
  if (!data.canUpdate) $('checkUpdate').style.display = 'none';
})();

$('uiLang').addEventListener('change', () => applyUiLang($('uiLang').value));

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
  status(T('测试语音识别中…'));
  try {
    const model = await api.testStt(collect());
    status(T('语音识别可用 ✓（模型：') + model + T('）'), 'ok');
  } catch (err) {
    status(T('语音识别测试失败：') + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace('NO_STT_KEY', T('没有填语音识别的 Key')), 'err');
  }
});

$('test').addEventListener('click', async () => {
  status(T('测试中…'));
  try {
    const out = await api.test(collect());
    status(T('连接成功 ✓  测试译文：') + out, 'ok');
  } catch (err) {
    status(T('连接失败：') + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace('NO_KEY', T('没有填 API Key')), 'err');
  }
});

$('save').addEventListener('click', async () => {
  try {
    await api.set(collect());
    status(T('已保存 ✓'), 'ok');
    setTimeout(() => window.close(), 600);
  } catch (err) {
    status(T('保存失败：') + err.message, 'err');
  }
});

$('checkUpdate').addEventListener('click', () => api.checkUpdate());
