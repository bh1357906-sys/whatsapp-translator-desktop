'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../core/proxy');

test('解析各种代理写法', () => {
  assert.deepEqual(P.parseProxyString('socks5://u:p@1.2.3.4:1080'), { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' });
  assert.deepEqual(P.parseProxyString('http://1.2.3.4:8080'), { type: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' });
  assert.deepEqual(P.parseProxyString('1.2.3.4:8080'), { type: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' });
  assert.deepEqual(P.parseProxyString('1.2.3.4:8080', 'socks5'), { type: 'socks5', host: '1.2.3.4', port: 8080, username: '', password: '' });
  assert.deepEqual(P.parseProxyString('proxy.example.com:8000:user1:pa:ss'), null); // 密码里有冒号且没用 @ → 无法判断
  assert.deepEqual(P.parseProxyString('1.2.3.4:8080:user1:pass1'), { type: 'http', host: '1.2.3.4', port: 8080, username: 'user1', password: 'pass1' });
  assert.deepEqual(P.parseProxyString('user1:pass1:gate.example.com:7777'), { type: 'http', host: 'gate.example.com', port: 7777, username: 'user1', password: 'pass1' });
  assert.deepEqual(P.parseProxyString('user1:pa%40ss@gate.example.com:7777'), { type: 'http', host: 'gate.example.com', port: 7777, username: 'user1', password: 'pa@ss' });
  assert.equal(P.parseProxyString('不是代理'), null);
  assert.equal(P.parseProxyString('1.2.3.4:99999'), null);
  assert.equal(P.parseProxyString('ftp://1.2.3.4:21'), null);
});

test('生成代理规则', () => {
  assert.deepEqual(P.proxyConfig(null), { mode: 'direct' });
  assert.deepEqual(P.proxyConfig({ type: 'none' }), { mode: 'direct' });
  assert.deepEqual(P.proxyConfig({ type: 'socks5', host: '1.2.3.4', port: 1080 }), { mode: 'fixed_servers', proxyRules: 'socks5://1.2.3.4:1080', proxyBypassRules: '<local>' });
});

test('检查配置', () => {
  assert.equal(P.validateProxy({ type: 'none' }), null);
  assert.equal(P.validateProxy({ type: 'http', host: 'a.com', port: 80, username: 'u', password: 'p' }), null);
  assert.ok(P.validateProxy({ type: 'socks5', host: 'a.com', port: 1080, username: 'u', password: 'p' }).includes('SOCKS'));
  assert.ok(P.validateProxy({ type: 'http', host: '', port: 80 }));
  assert.ok(P.validateProxy({ type: 'http', host: 'a.com', port: 0 }));
});
