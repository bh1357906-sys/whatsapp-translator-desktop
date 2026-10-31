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
  assert.equal(L.validateOutgoing('你好', '了解', 'Japanese'), null);
  assert.ok(L.validateOutgoing('你好', '今天天气很好啊', 'Japanese'));
  assert.ok(L.validateOutgoing('你好', '你好呀', 'English'));
  assert.equal(L.validateOutgoing('你好', 'Hi there', 'English'), null);
  assert.equal(L.validateOutgoing('我叫小明', 'My name is 小明', 'English'), null);
  assert.ok(L.validateOutgoing('你好', '  ', 'English'));
  assert.equal(L.validateOutgoing('你好', '안녕하세요', 'Korean'), null);
});

test('looseEqual 忽略标点和表情', () => {
  assert.equal(L.looseEqual('Hello, world! 😀', 'hello world'), true);
  assert.equal(L.looseEqual('Hello', 'Hi'), false);
});
