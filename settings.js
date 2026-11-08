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
function ttsKeyName() {
  const p = (data.ttsEngines || {})[$('ttsEngine').value] || {};
  return p.keyName || 'tts_' + $('ttsEngine').value;
}
let elVoices = []; // ElevenLabs 声音列表（设置里缓存的 / 刚拉取的）
let elVoice = '';
let elClonedVoiceId = '';
function fillElVoices() {
  const list = elVoices.length ? elVoices : (data.elDefaultVoices || []).map((v) => ({ id: v.id, label: v.label }));
  fillSelect($('ttsVoice'), list.map((v) => [v.id, (v.cloned ? '★ ' : '') + T(v.label)]), elVoice || elClonedVoiceId || (list[0] && list[0].id) || '');
}
function showTts() {
  const e = $('ttsEngine').value;
  const preset = (data.ttsEngines || {})[e] || {};
  const el = e === 'elevenlabs';
  $('ttsKey').value = keys[ttsKeyName()] || '';
  $('ttsKey').placeholder = el ? 'sk_... / xi-api-key' : 'sk-...';
  $('ttsApiBase').placeholder = preset.apiBase || 'https://your-endpoint/v1';
  $('ttsModel').placeholder = preset.model || T('模型名');
  if (e === 'custom') $('ttsAdv').open = true;
  $('ttsHintEl').style.display = el ? '' : 'none';
  $('ttsHintOa').style.display = el ? 'none' : '';
  $('ttsRefresh').style.display = el ? '' : 'none';
  $('elVoiceHint').style.display = el ? '' : 'none';
  $('elStabilityRow').style.display = el ? '' : 'none';
  $('cloneSec').style.display = el ? '' : 'none';
  $('ttsStyleRow').style.display = el ? 'none' : '';
  if (el) fillElVoices();
  else fillSelect($('ttsVoice'), (data.ttsVoices || []).map((v) => [v.id, T(v.label)]), (data.settings && data.settings.ttsVoice) || 'coral');
  $('cloneCurrent').style.display = el && elClonedVoiceId ? '' : 'none';
}
// 三个地方选了同一个 Key（都是 openai）时保持同步
function syncSharedKey(from) {
  const names = { tr: $('engine').value, stt: sttKeyName(), tts: ttsKeyName() };
  const fields = { tr: 'apiKey', stt: 'sttKey', tts: 'ttsKey' };
  const v = $(fields[from]).value;
  Object.keys(names).forEach((k) => {
    if (k !== from && names[k] === names[from]) $(fields[k]).value = v;
  });
}

function status(msg, cls) {
  const st = $('status');
  st.textContent = msg;
  st.className = cls || '';
}

function collect() {
  keys[$('engine').value] = $('apiKey').value.trim();
  if (data.sttEngines) keys[sttKeyName()] = $('sttKey').value.trim();
  if (data.ttsEngines) keys[ttsKeyName()] = $('ttsKey').value.trim();
  return {
    voiceSend: $('voiceSend').checked,
    ttsEngine: $('ttsEngine').value,
    ttsApiBase: $('ttsApiBase').value.trim(),
    ttsModel: $('ttsModel').value.trim(),
    ttsVoice: $('ttsEngine').value === 'elevenlabs' ? (data.settings && data.settings.ttsVoice) || 'coral' : $('ttsVoice').value,
    elVoice: $('ttsEngine').value === 'elevenlabs' ? $('ttsVoice').value : elVoice,
    elVoices,
    elStability: parseFloat($('elStability').value),
    ttsSpeed: parseFloat($('ttsSpeed').value) || 1,
    ttsStyle: $('ttsStyle').value.trim(),
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
    hardGuard: $('hardGuard').checked,
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
    imageTranslate: $('imageTranslate').checked,
    sendKey: $('sendKey').value,
    quickPhrases: $('quickPhrases').value,
    monthlyTokenBudget: parseInt($('monthlyTokenBudget').value, 10) || 0,
    budgetFallback: $('budgetFallback').checked,
    apiProxy: readApiProxy(),
    closeToTray: $('closeToTray').checked,
    notifyTranslated: $('notifyTranslated').checked,
  };
}

function readApiProxy() {
  const type = $('apType').value;
  if (type === 'none' || type === 'system') return { type };
  return { type, host: $('apHost').value.trim(), port: $('apPort').value.trim(), username: $('apUser').value.trim(), password: $('apPass').value };
}
function syncApFields() {
  const t = $('apType').value;
  $('apFields').style.display = t === 'none' || t === 'system' ? 'none' : 'block';
}

// 界面语言：静态文字用词典替换，下拉框重新填
function applyUiLang(l, s) {
  I18N.setLang(l);
  I18N.localizeDom(document.body);
  const cur = s || { engine: $('engine').value, myLang: $('myLang').value, defaultTheirLang: $('defaultTheirLang').value, sttEngine: $('sttEngine').value, ttsEngine: $('ttsEngine').value, ttsVoice: $('ttsVoice').value };
  fillSelect($('engine'), Object.entries(data.engines).map(([k, v]) => [k, T(v.label)]), cur.engine);
  const langs = data.languages.map((l2) => [l2.name, l === 'en' ? l2.name : l2.label || l2.name]);
  fillSelect($('myLang'), langs, cur.myLang);
  fillSelect($('defaultTheirLang'), langs, cur.defaultTheirLang);
  if (data.sttEngines) fillSelect($('sttEngine'), Object.entries(data.sttEngines).map(([k, v]) => [k, T(v.label)]), cur.sttEngine || 'groq');
  if (data.ttsEngines) fillSelect($('ttsEngine'), Object.entries(data.ttsEngines).map(([k, v]) => [k, T(v.label)]), cur.ttsEngine || 'openai');
  if (data.ttsEngines) showTts();
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
  $('hardGuard').checked = s.hardGuard !== false;
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
  $('voiceSend').checked = s.voiceSend !== false;
  elVoices = Array.isArray(s.elVoices) ? s.elVoices : [];
  elVoice = s.elVoice || '';
  elClonedVoiceId = s.elClonedVoiceId || '';
  $('elStability').value = String(s.elStability === undefined ? 0.5 : s.elStability);
  if (data.ttsEngines) {
    $('ttsApiBase').value = s.ttsApiBase || '';
    $('ttsModel').value = s.ttsModel || '';
    if (s.ttsApiBase || s.ttsModel) $('ttsAdv').open = true;
    showTts();
  }
  $('ttsSpeed').value = String(s.ttsSpeed || 1);
  if ($('ttsSpeed').value !== String(s.ttsSpeed || 1)) $('ttsSpeed').value = '1';
  $('ttsStyle').value = s.ttsStyle || '';
  $('voiceTranslate').checked = s.voiceTranslate !== false;
  $('voiceAutoOnPlay').checked = s.voiceAutoOnPlay !== false;
  $('voiceAutoTranslate').checked = s.voiceAutoTranslate !== false;
  $('imageTranslate').checked = s.imageTranslate !== false;
  $('sendKey').value = s.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
  $('quickPhrases').value = s.quickPhrases || '';
  $('monthlyTokenBudget').value = s.monthlyTokenBudget || 0;
  $('budgetFallback').checked = !!s.budgetFallback;
  const ap = s.apiProxy || { type: 'none' };
  $('apType').value = ap.type || 'none';
  $('apHost').value = ap.host || '';
  $('apPort').value = ap.port || '';
  $('apUser').value = ap.username || '';
  $('apPass').value = '';
  $('apPass').placeholder = ap.hasPassword ? T('已保存（不修改请留空）') : '';
  syncApFields();
  $('closeToTray').checked = s.closeToTray !== false;
  $('notifyTranslated').checked = s.notifyTranslated !== false;
  if (!data.isDesktop) {
    $('desktopHead').style.display = 'none';
    $('desktopSec').style.display = 'none';
    $('apiProxySec').style.display = 'none'; // 插件版的代理由浏览器管
  }
  if (data.encrypted) {
    $('encNote').style.display = '';
    $('encNote2').style.display = '';
  }
  if (!data.canUpdate) $('checkUpdate').style.display = 'none';
})();

$('apType').addEventListener('change', syncApFields);
$('testApiProxy').addEventListener('click', async () => {
  const ap = readApiProxy();
  if (ap.type === 'none') return status(T('当前是直连，不需要测试'));
  if (ap.type === 'system') return status(T('跟随系统代理，以系统设置为准'));
  status(T('正在通过代理连接…（最多约 15 秒）'));
  try {
    const r = await api.testApiProxy(ap);
    status(T('✓ 代理可用，出口 IP：') + r.ip + (r.place ? T('（') + r.place + T('）') : ''), 'ok');
  } catch (err) {
    status('✗ ' + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
  }
});
let clearArmed = false;
$('clearCache').addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    $('clearCache').textContent = T('确定清除？再点一次');
    setTimeout(() => {
      clearArmed = false;
      $('clearCache').textContent = T('清除本机缓存的聊天内容');
    }, 4000);
    return;
  }
  clearArmed = false;
  $('clearCache').textContent = T('清除本机缓存的聊天内容');
  try {
    await api.clearCache();
    status(T('已清除 ✓'), 'ok');
  } catch (err) {
    status(T('清除失败：') + err.message, 'err');
  }
});

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
$('ttsKey').addEventListener('input', () => syncSharedKey('tts'));

let lastTts = null;
$('ttsEngine').addEventListener('focus', () => (lastTts = ttsKeyName()));
$('ttsEngine').addEventListener('change', () => {
  if (lastTts) keys[lastTts] = $('ttsKey').value.trim();
  lastTts = ttsKeyName();
  if ($('ttsEngine').value !== 'custom') {
    $('ttsApiBase').value = '';
    $('ttsModel').value = '';
  }
  showTts();
});
$('ttsVoice').addEventListener('change', () => {
  if ($('ttsEngine').value === 'elevenlabs') elVoice = $('ttsVoice').value;
});
$('ttsRefresh').addEventListener('click', async () => {
  status(T('正在拉取声音列表…'));
  try {
    const list = await api.ttsVoices(collect());
    elVoices = list || [];
    fillElVoices();
    status(T('已拉取 {0} 个声音', elVoices.length), 'ok');
  } catch (err) {
    status(T('拉取失败：') + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace('NO_TTS_KEY', T('没有填语音合成的 Key')), 'err');
  }
});

// ---- 克隆我的声音：当场录音 → 上传 ----
let cloneRec = null;
let cloneBlob = null;
let cloneTimerId = null;
function cloneSetUI(state) {
  $('cloneRec').style.display = state === 'idle' || state === 'done' ? '' : 'none';
  $('cloneStop').style.display = state === 'rec' ? '' : 'none';
  $('clonePlay').style.display = state === 'done' ? '' : 'none';
  $('cloneUpload').style.display = state === 'done' ? '' : 'none';
}
$('cloneRec').addEventListener('click', async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    return ($('cloneStatus').textContent = T('没能打开麦克风：{0}', (err && (err.message || err.name)) || err));
  }
  const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 128000 } : { audioBitsPerSecond: 128000 });
  const chunks = [];
  const t0 = Date.now();
  mr.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(cloneTimerId);
    cloneBlob = new Blob(chunks, { type: (mr.mimeType || 'audio/webm').split(';')[0] });
    const secs = Math.round((Date.now() - t0) / 1000);
    $('cloneTimer').textContent = T('已录 {0} 秒', secs);
    if (secs < 30) {
      $('cloneStatus').textContent = T('太短了，至少录 30 秒（建议 1～2 分钟），请重新录');
      cloneBlob = null;
      cloneSetUI('idle');
      return;
    }
    $('cloneStatus').textContent = T('录好了，可以回放听一下，满意就点「上传并克隆」');
    cloneSetUI('done');
  };
  cloneRec = mr;
  mr.start(500);
  cloneSetUI('rec');
  $('cloneStatus').textContent = T('正在录音…像平时发语音那样随便说，1～2 分钟后点停止（最长 3 分钟）');
  cloneTimerId = setInterval(() => {
    const secs = Math.round((Date.now() - t0) / 1000);
    $('cloneTimer').textContent = T('录音中 {0} 秒', secs);
    if (secs >= 180) mr.stop();
  }, 500);
});
$('cloneStop').addEventListener('click', () => cloneRec && cloneRec.state !== 'inactive' && cloneRec.stop());
$('clonePlay').addEventListener('click', () => {
  if (!cloneBlob) return;
  const a = new Audio(URL.createObjectURL(cloneBlob));
  a.play();
});
$('cloneUpload').addEventListener('click', async () => {
  if (!cloneBlob) return;
  $('cloneUpload').disabled = true;
  $('cloneStatus').textContent = T('上传中，ElevenLabs 处理大约 10～30 秒…');
  try {
    const b64 = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(cloneBlob);
    });
    const r = await api.cloneVoice({ ...collect(), audio: b64, mime: cloneBlob.type, name: 'My voice' });
    elClonedVoiceId = r.voiceId;
    elVoice = r.voiceId;
    elVoices = r.voices || elVoices;
    fillElVoices();
    $('cloneCurrent').style.display = '';
    $('cloneStatus').textContent = T('克隆完成 ✓ 已设为默认声音，点「试听」听听效果');
    cloneBlob = null;
    cloneSetUI('idle');
    $('cloneTimer').textContent = '';
  } catch (err) {
    $('cloneStatus').textContent = T('克隆失败：') + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace('NO_TTS_KEY', T('没有填语音合成的 Key'));
  } finally {
    $('cloneUpload').disabled = false;
  }
});
$('cloneDelete').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await api.deleteClonedVoice();
    elVoices = elVoices.filter((v) => v.id !== elClonedVoiceId);
    if (elVoice === elClonedVoiceId) elVoice = '';
    elClonedVoiceId = '';
    fillElVoices();
    $('cloneCurrent').style.display = 'none';
    $('cloneStatus').textContent = T('已删除「我的声音」');
  } catch (err) {
    $('cloneStatus').textContent = T('删除失败：') + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});

let ttsPlayer = null;
$('testTts').addEventListener('click', async () => {
  status(T('合成中…'));
  try {
    const r = await api.testTts({ ...collect(), sampleLang: 'English' });
    if (ttsPlayer) ttsPlayer.pause();
    ttsPlayer = new Audio('data:' + (r.mime || 'audio/mpeg') + ';base64,' + r.b64);
    await ttsPlayer.play();
    status(T('语音合成可用 ✓（模型：') + r.model + T('）正在播放…'), 'ok');
  } catch (err) {
    status(T('试听失败：') + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace('NO_TTS_KEY', T('没有填语音合成的 Key')), 'err');
  }
});

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
