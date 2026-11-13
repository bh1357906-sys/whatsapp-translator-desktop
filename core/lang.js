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

// 汉字 + 注音符号（台湾输入法）：这两种一出现就是中文
const RE_HAN = /[\p{Script=Han}\p{Script=Bopomofo}]/gu;
// 中文输入法打出来的全角标点 / 全角字母数字（外语里不会有；对方一看就知道是用中文输入法打的）
const RE_CJK_PUNCT = /[\u3000-\u3004\u3008-\u3020\u3030\u303D-\u303F\uFE10-\uFE1F\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]/gu;
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

// 目标语言是不是用全角标点的（中文、日文）
function usesCjkPunct(target) {
  return isChineseLang(target) || target === 'Japanese';
}

function hasCjkPunct(t) {
  return count(RE_CJK_PUNCT, t) > 0;
}

// 把中文全角标点 / 全角字母数字换成半角（发给外国人的消息里不该出现“，。？！”）
function normalizeCjkPunct(text) {
  let s = String(text || '');
  if (!hasCjkPunct(s)) return s;
  s = s
    .replace(/(\d)：(\d)/g, '$1:$2')
    .replace(/[，、]/g, ', ')
    .replace(/。/g, '. ')
    .replace(/；/g, '; ')
    .replace(/：/g, ': ')
    .replace(/！/g, '! ')
    .replace(/？/g, '? ')
    .replace(/（/g, ' (')
    .replace(/）/g, ') ')
    .replace(/[【〔〖]/g, ' [')
    .replace(/[】〕〗]/g, '] ')
    .replace(/[《〈「『]/g, ' "')
    .replace(/[》〉」』]/g, '" ')
    .replace(/[〜～]/g, '~')
    .replace(/\u3000/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(RE_CJK_PUNCT, ' ');
  return s
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ ([,.;:!?)\]])/g, '$1')
        .replace(/([(\[]) /g, '$1')
        .replace(/^ +| +$/g, '')
    )
    .join('\n');
}

// 发送方向：返回 null 表示需要处理（翻译，或至少把全角标点换掉）；否则返回原样发送的原因
function outgoingPassReason(text, myLang, target) {
  // 发给非中日文的对方：草稿里有中文全角标点就不能原样发
  if (!usesCjkPunct(target) && hasCjkPunct(text)) return null;
  if (!hasLetters(text) || isOnlyUrl(text)) return 'no-letters';
  if (target === 'Simplified Chinese' && looksChinese(text)) return 'same-lang';
  // 我的语言是中文，但草稿里一个汉字都没有：说明我直接用外语写的（或点选了 Wingman 建议），不再翻译
  if (isChineseLang(myLang) && !isChineseLang(target) && !hasHan(text)) return 'already-foreign';
  return null;
}

// 草稿里没有需要翻译的内容，只是夹着中文全角标点：换成半角就能发（不用调翻译接口）。不是这种情况返回 null
function punctOnlyFix(text, myLang, target) {
  if (usesCjkPunct(target) || !hasCjkPunct(text)) return null;
  const fixed = normalizeCjkPunct(text);
  if (hasCjkPunct(fixed)) return null;
  if (!hasLetters(fixed) || isOnlyUrl(fixed)) return fixed;
  if (isChineseLang(myLang) && !hasHan(fixed)) return fixed;
  return null;
}

// 发送方向的译文检查：发现明显没翻译成功就报错，不发出去
function validateOutgoing(input, output, target) {
  const out = String(output || '').trim();
  if (!out) return '译文为空';
  if (isChineseLang(target)) return null;
  const s = scriptStats(out);
  if (target === 'Japanese') {
    // 日文一定带假名；只有汉字、没有假名 = 多半还是中文（和护栏用同一条规则，免得译文过了这里又被护栏拦住）
    if (s.han > 0 && s.kana === 0) return '译文看起来仍是中文，不是日文';
    return null;
  }
  // 目标不是中文 / 日文：译文里一个汉字都不能有（哪怕只是夹着一个词）
  if (s.han > 0) return '译文里仍含有中文';
  return null;
}

// 护栏：这段文字如果原样发出去，会不会把中文（或“我的语言”）发给对方？
// 返回 null = 可以发；否则是原因：
//   'han'            含中文，对方语言不是中文 → 绝不能原样发
//   'zh-unconfirmed' 对方语言设成了中文，但这个聊天还没有确认过“直接发中文” → 先确认
//   'mylang'         我的语言是日文 / 韩文，草稿里是日文 / 韩文，对方语言不是
// 注意：不看“我的语言”设置——哪怕有人把“我的语言”改成了别的，中文照样拦。target 为空（还没识别出聊天）按“不是中文”算。
function guardReason(text, myLang, target, zhOk) {
  const t = String(text || '');
  if (!t) return null;
  if (hasHan(t)) {
    if (isChineseLang(target)) return zhOk ? null : 'zh-unconfirmed';
    if (target === 'Japanese' && count(RE_KANA, t) > 0) return null;
    return 'han';
  }
  if (myLang === 'Japanese' && target !== 'Japanese' && count(RE_KANA, t) > 0) return 'mylang';
  if (myLang === 'Korean' && target !== 'Korean' && count(RE_HANGUL, t) > 0) return 'mylang';
  return null;
}

function guardBlocks(text, myLang, target, zhOk) {
  return !!guardReason(text, myLang, target, zhOk);
}

// 阅读方向的译文检查：模型偶尔会把外语“改写”一遍而不是翻成我的语言，这种结果不能用
// 返回 true = 看起来没翻成 myLang（需要重试）
function readOutputLooksWrong(input, output, myLang) {
  const out = String(output || '').trim();
  if (!out) return false;
  if (looseEqual(out, input)) {
    // 原样返回：拉丁字母的人名、品牌、型号不算错；但亚美尼亚文、俄文、阿拉伯文等原样返回 = 没翻
    if (!isChineseLang(myLang) && myLang !== 'Japanese' && myLang !== 'Korean' && ['Russian', 'Arabic', 'Urdu', 'Hindi', 'Bengali', 'Tamil', 'Armenian', 'Thai'].includes(myLang)) return false;
    const st = scriptStats(input);
    const foreign = st.other - count(/\p{Script=Latin}/gu, input);
    return foreign >= 3;
  }
  const o = scriptStats(out);
  if (!o.letters) return false;
  if (isChineseLang(myLang)) return o.han === 0 && o.letters >= 4; // 一个汉字都没有
  if (myLang === 'Japanese') return o.kana === 0 && o.han === 0 && o.letters >= 4;
  if (myLang === 'Korean') return o.hangul === 0 && o.letters >= 4;
  // 其他（拉丁字母等）语言：原文是非拉丁文字（如亚美尼亚、俄文、阿拉伯文），译文还是那种文字 → 没翻
  const nonLatin = (t) => count(/[\p{L}]/gu, t) - count(/[\p{Script=Latin}]/gu, t);
  const latinTarget = !['Russian', 'Arabic', 'Urdu', 'Hindi', 'Bengali', 'Tamil', 'Armenian', 'Thai'].includes(myLang);
  return latinTarget && nonLatin(out) > o.letters * 0.6 && looseEqual(out.slice(0, 2), String(input).trim().slice(0, 2));
}

module.exports = {
  readOutputLooksWrong,
  guardBlocks,
  guardReason,
  hasCjkPunct,
  normalizeCjkPunct,
  punctOnlyFix,
  usesCjkPunct,
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
