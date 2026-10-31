// 语言列表 + 文字检测（主进程和页面共用）
'use strict';

const LANGUAGES = [
  { name: 'English', code: 'EN', label: '英语 English' },
  { name: 'Simplified Chinese', code: '中', label: '简体中文 Simplified Chinese' },
  { name: 'Traditional Chinese', code: '繁', label: '繁体中文 Traditional Chinese' },
  { name: 'Malay', code: 'MS', label: '马来语 Malay' },
  { name: 'Indonesian', code: 'ID', label: '印尼语 Indonesian' },
  { name: 'Hindi', code: 'HI', label: '印地语 Hindi' },
  { name: 'Hinglish', code: 'HN', label: '印式英语(罗马字印地语) Hinglish' },
  { name: 'Urdu', code: 'UR', label: '乌尔都语 Urdu' },
  { name: 'Bengali', code: 'BN', label: '孟加拉语 Bengali' },
  { name: 'Tamil', code: 'TA', label: '泰米尔语 Tamil' },
  { name: 'Armenian', code: 'HY', label: '亚美尼亚语 Armenian' },
  { name: 'Arabic', code: 'AR', label: '阿拉伯语 Arabic' },
  { name: 'Turkish', code: 'TR', label: '土耳其语 Turkish' },
  { name: 'Russian', code: 'RU', label: '俄语 Russian' },
  { name: 'Spanish', code: 'ES', label: '西班牙语 Spanish' },
  { name: 'Portuguese', code: 'PT', label: '葡萄牙语 Portuguese' },
  { name: 'French', code: 'FR', label: '法语 French' },
  { name: 'German', code: 'DE', label: '德语 German' },
  { name: 'Italian', code: 'IT', label: '意大利语 Italian' },
  { name: 'Japanese', code: 'JA', label: '日语 Japanese' },
  { name: 'Korean', code: 'KO', label: '韩语 Korean' },
  { name: 'Vietnamese', code: 'VI', label: '越南语 Vietnamese' },
  { name: 'Thai', code: 'TH', label: '泰语 Thai' },
  { name: 'Filipino', code: 'FIL', label: '菲律宾语 Filipino' },
];

const LANG_NAMES = new Set(LANGUAGES.map((l) => l.name));

function isChineseLang(name) {
  return name === 'Simplified Chinese' || name === 'Traditional Chinese';
}

function langLabel(name) {
  const l = LANGUAGES.find((x) => x.name === name);
  return (l && (l.label || l.name)) || name || '';
}

function langCode(name) {
  const l = LANGUAGES.find((x) => x.name === name);
  return (l && l.code) || '?';
}

// 给模型看的语言描述
function promptLangName(name) {
  if (name === 'Hinglish') {
    return 'Hinglish (Hindi written in Latin/Roman script mixed with English words, the casual way Indians type in chat apps — NOT Devanagari script)';
  }
  if (name === 'Simplified Chinese') return 'Simplified Chinese (简体中文)';
  if (name === 'Traditional Chinese') return 'Traditional Chinese (繁體中文)';
  return name;
}

const RE_HAN = /\p{Script=Han}/gu;
const RE_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const RE_HANGUL = /\p{Script=Hangul}/gu;
const RE_LETTER = /\p{L}/gu;

function count(re, t) {
  const m = String(t || '').match(re);
  return m ? m.length : 0;
}

function scriptStats(t) {
  const han = count(RE_HAN, t);
  const kana = count(RE_KANA, t);
  const hangul = count(RE_HANGUL, t);
  const letters = count(RE_LETTER, t);
  return { han, kana, hangul, other: letters - han - kana - hangul, letters };
}

function hasHan(t) {
  return count(RE_HAN, t) > 0;
}

// “这段主要是中文”：有汉字、没有假名/韩文，且汉字不少于其他字母的一半
// （中文一个词约 2 个字，英文一个词约 5 个字母）
// 日文（有假名）不会被误判为中文。
function looksChinese(t) {
  const s = scriptStats(t);
  if (s.han === 0 || s.kana > 0 || s.hangul > 0) return false;
  return s.han * 2 >= s.other;
}

// 没有任何字母（纯表情、数字、标点）→ 不需要翻译
function hasLetters(t) {
  return count(RE_LETTER, t) > 0;
}

function isOnlyUrl(t) {
  return /^\s*(https?:\/\/\S+\s*)+$/i.test(String(t || ''));
}

// 只比较字母和数字，忽略空白、标点、表情差异
function looseEqual(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return n(a) === n(b);
}

// 阅读方向（收到的 / 自己发的显示成我的语言）：是否需要调用翻译
function needsReadTranslation(text, myLang) {
  if (!hasLetters(text) || isOnlyUrl(text)) return false;
  if (myLang === 'Simplified Chinese' && looksChinese(text)) return false;
  return true;
}

// 发送方向：返回 null 表示需要翻译；否则返回原样发送的原因
function outgoingPassReason(text, myLang, target) {
  if (!hasLetters(text) || isOnlyUrl(text)) return 'no-letters';
  if (target === 'Simplified Chinese' && looksChinese(text)) return 'same-lang';
  // 我的语言是中文，但草稿里一个汉字都没有：说明我直接用外语写的（或点选了 Wingman 建议），不再翻译
  if (isChineseLang(myLang) && !isChineseLang(target) && !hasHan(text)) return 'already-foreign';
  return null;
}

// 发送方向的译文检查：发现明显没翻译成功就报错，不发出去
function validateOutgoing(input, output, target) {
  const out = String(output || '').trim();
  if (!out) return '译文为空';
  if (isChineseLang(target)) return null;
  const s = scriptStats(out);
  if (target === 'Japanese') {
    if (s.kana === 0 && s.han >= 4) return '译文看起来仍是中文，不是日文';
    return null;
  }
  if (target === 'Korean') {
    if (s.hangul === 0 && looksChinese(out)) return '译文看起来仍是中文，不是韩文';
    return null;
  }
  if (looksChinese(out)) return '译文看起来仍是中文';
  return null;
}

module.exports = {
  LANGUAGES,
  LANG_NAMES,
  isChineseLang,
  langLabel,
  langCode,
  promptLangName,
  scriptStats,
  hasHan,
  looksChinese,
  hasLetters,
  isOnlyUrl,
  looseEqual,
  needsReadTranslation,
  outgoingPassReason,
  validateOutgoing,
};
