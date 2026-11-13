'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../core/lang');

test('looksChinese：中文 / 日文 / 混合', () => {
  assert.equal(L.looksChinese('你好，今天怎么样？'), true);
  assert.equal(L.looksChinese('OK 好的'), true);
  assert.equal(L.looksChinese('今日は天気がいいですね'), false); // 日文有假名
  assert.equal(L.looksChinese('I love 北京'), false);
  assert.equal(L.looksChinese('hello'), false);
  assert.equal(L.looksChinese('안녕하세요'), false);
});

test('读消息：中文不翻、日文要翻、纯表情不翻', () => {
  assert.equal(L.needsReadTranslation('你好', 'Simplified Chinese'), false);
  assert.equal(L.needsReadTranslation('今日は暑いです', 'Simplified Chinese'), true);
  assert.equal(L.needsReadTranslation('😂😂', 'Simplified Chinese'), false);
  assert.equal(L.needsReadTranslation('12:30', 'Simplified Chinese'), false);
  assert.equal(L.needsReadTranslation('https://a.com/x', 'Simplified Chinese'), false);
  assert.equal(L.needsReadTranslation('How are you', 'Simplified Chinese'), true);
});

test('发送：哪些情况原样发出', () => {
  const my = 'Simplified Chinese';
  assert.equal(L.outgoingPassReason('你好', my, 'English'), null);
  assert.equal(L.outgoingPassReason('hello there', my, 'English'), 'already-foreign');
  assert.equal(L.outgoingPassReason('👍', my, 'English'), 'no-letters');
  assert.equal(L.outgoingPassReason('你好', my, 'Simplified Chinese'), 'same-lang');
  assert.equal(L.outgoingPassReason('你好', my, 'Japanese'), null);
  assert.equal(L.outgoingPassReason('你好', my, 'Traditional Chinese'), null); // 简→繁要转换
});

test('发送：译文检查不再误伤日文', () => {
  assert.equal(L.validateOutgoing('你好', '今日は天気がいいですね', 'Japanese'), null);
  assert.equal(L.validateOutgoing('你好', '了解です', 'Japanese'), null);
  // 只有汉字、没有假名：多半还是中文（和护栏同一条规则；这时会让模型带上假名重译一次）
  assert.ok(L.validateOutgoing('你好', '了解', 'Japanese'));
  assert.ok(L.validateOutgoing('你好', '今天天气很好啊', 'Japanese'));
  assert.ok(L.validateOutgoing('你好', '你好呀', 'English'));
  assert.equal(L.validateOutgoing('你好', 'Hi there', 'English'), null);
  // 护栏规则：目标不是中文/日文时，译文里一个汉字都不能有（名字也要写成拼音）
  assert.ok(L.validateOutgoing('我叫小明', 'My name is 小明', 'English'));
  assert.equal(L.validateOutgoing('我叫小明', 'My name is Xiaoming', 'English'), null);
  assert.ok(L.validateOutgoing('你好', '  ', 'English'));
  assert.equal(L.validateOutgoing('你好', '안녕하세요', 'Korean'), null);
});

test('looseEqual 忽略标点和表情', () => {
  assert.equal(L.looseEqual('Hello, world! 😀', 'hello world'), true);
  assert.equal(L.looseEqual('Hello', 'Hi'), false);
});

test('护栏：含中文的草稿不能原样发给非中文的对方', () => {
  const my = 'Simplified Chinese';
  assert.equal(L.guardBlocks('你好', my, 'English'), true);
  assert.equal(L.guardBlocks('OK 好的', my, 'Malay'), true);
  assert.equal(L.guardBlocks('Hello', my, 'English'), false);
  assert.equal(L.guardBlocks('東京です', my, 'Japanese'), false); // 日文译文带假名，放行
  assert.equal(L.guardBlocks('你好', my, 'Japanese'), true); // 纯汉字 = 还是中文
  assert.equal(L.guardBlocks('😀😀', my, 'English'), false);
  assert.equal(L.guardBlocks('', my, 'English'), false);
  assert.equal(L.guardBlocks('Hello', 'English', 'Spanish'), false);
});

test('护栏：不看“我的语言”、不认没确认过的中文聊天', () => {
  // “我的语言”被改成了别的：中文照样拦
  assert.equal(L.guardReason('你好', 'English', 'English'), 'han');
  assert.equal(L.guardReason('你好', 'Malay', 'Hindi'), 'han');
  // 还没识别出聊天（目标语言为空）：按“不是中文”算
  assert.equal(L.guardReason('你好', 'Simplified Chinese', ''), 'han');
  assert.equal(L.guardReason('你好', 'Simplified Chinese', undefined), 'han');
  // 对方语言是中文：只有这个聊天确认过才放行
  assert.equal(L.guardReason('你好', 'Simplified Chinese', 'Simplified Chinese'), 'zh-unconfirmed');
  assert.equal(L.guardReason('你好', 'Simplified Chinese', 'Traditional Chinese', false), 'zh-unconfirmed');
  assert.equal(L.guardReason('你好', 'Simplified Chinese', 'Simplified Chinese', true), null);
  assert.equal(L.guardReason('妳好', 'Simplified Chinese', 'Traditional Chinese', true), null);
  // 确认过发中文，也只对中文目标有效
  assert.equal(L.guardReason('你好', 'Simplified Chinese', 'English', true), 'han');
  // 注音符号也算中文
  assert.equal(L.guardReason('ㄋㄧˇ ㄏㄠˇ', 'Simplified Chinese', 'English'), 'han');
  // 英文排版里的弯引号、破折号、省略号不算中文
  assert.equal(L.guardReason('He said “wait” — then… left', 'Simplified Chinese', 'English'), null);
  // 我的语言是日文 / 韩文
  assert.equal(L.guardReason('こんにちは', 'Japanese', 'English'), 'mylang');
  assert.equal(L.guardReason('안녕하세요', 'Korean', 'English'), 'mylang');
});

test('中文全角标点：发给外国人前换成半角', () => {
  const my = 'Simplified Chinese';
  assert.equal(L.normalizeCjkPunct('ok，thanks。'), 'ok, thanks.');
  assert.equal(L.normalizeCjkPunct('Hello（world）！Are you ok？'), 'Hello (world)! Are you ok?');
  assert.equal(L.normalizeCjkPunct('see you at 10：30'), 'see you at 10:30');
  assert.equal(L.normalizeCjkPunct('ＡＢＣ１２３'), 'ABC123');
  assert.equal(L.normalizeCjkPunct('line one，\nline two。'), 'line one,\nline two.');
  assert.equal(L.normalizeCjkPunct('plain text, nothing to do'), 'plain text, nothing to do');
  assert.equal(L.hasCjkPunct('He said “wait” — then… left · ok'), false);
  // 发送判断：有全角标点就不能原样发（中文、日文目标除外）
  assert.equal(L.outgoingPassReason('ok，thanks', my, 'English'), null);
  assert.equal(L.outgoingPassReason('？？？', my, 'English'), null);
  assert.equal(L.outgoingPassReason('ok, thanks', my, 'English'), 'already-foreign');
  assert.equal(L.outgoingPassReason('はい、わかりました。', my, 'Japanese'), 'already-foreign');
  // 只是标点问题 → 本地换掉，不用翻译
  assert.equal(L.punctOnlyFix('ok，thanks', my, 'English'), 'ok, thanks');
  assert.equal(L.punctOnlyFix('？？？', my, 'English'), '???');
  assert.equal(L.punctOnlyFix('你好，thanks', my, 'English'), null); // 有中文 → 要翻译
  assert.equal(L.punctOnlyFix('ok, thanks', my, 'English'), null); // 没有全角标点
  assert.equal(L.punctOnlyFix('はい、わかりました。', my, 'Japanese'), null);
});
