'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stepDelay, RETRY_STEPS, AUTH_RETRY_STEPS, CRASH_STEPS, createAuthGate, createLogBudget, failKind, siteHost } = require('../core/health');

test('重试间隔：先快后慢，最后固定在最后一档；乱传参数也不出错', () => {
  assert.strictEqual(stepDelay(RETRY_STEPS, 0), 3000);
  assert.strictEqual(stepDelay(RETRY_STEPS, 1), 8000);
  assert.strictEqual(stepDelay(RETRY_STEPS, 4), 60000);
  assert.strictEqual(stepDelay(RETRY_STEPS, 99), 60000);
  assert.strictEqual(stepDelay(RETRY_STEPS, -5), 3000);
  assert.strictEqual(stepDelay(RETRY_STEPS, undefined), 3000);
  assert.strictEqual(stepDelay(CRASH_STEPS, 0), 2000);
  assert.strictEqual(stepDelay(AUTH_RETRY_STEPS, 99), 300000);
});

test('代理验证：密码对的时候，问一次答一次，问多少次都答（多个请求同时问）', () => {
  const g = createAuthGate();
  for (let i = 0; i < 8; i++) assert.strictEqual(g.ask(1000 + i, true), 'answer');
  assert.deepStrictEqual(g.state(), { strikes: 0, lockUntil: 0 });
});

test('代理验证：代理抽风拒了一次，再答照样能过——不会像以前那样“只答一次，之后永远不答”', () => {
  const g = createAuthGate();
  assert.strictEqual(g.ask(0, true), 'answer'); // 启动时
  // 一小时后代理拒了一次缓存的密码，内核又来问（first=false）
  const t = 3600000;
  assert.strictEqual(g.ask(t, false), 'answer');
  g.ok(); // 这次过了
  // 之后再抽风，仍然照答
  assert.strictEqual(g.ask(t + 50000, false), 'answer');
  assert.strictEqual(g.ask(t + 99000, false), 'answer');
  assert.strictEqual(g.ask(t + 150000, false), 'answer');
  assert.strictEqual(g.state().strikes, 0);
});

test('代理验证：密码真的不对——半分钟内再答 3 次就停，歇 1 分钟 → 2 分钟 → 5 分钟，歇过之后每次只试 1 次', () => {
  const g = createAuthGate();
  let t = 0;
  assert.strictEqual(g.ask(t, true), 'answer');
  assert.strictEqual(g.ask((t += 100), false), 'answer');
  assert.strictEqual(g.ask((t += 100), false), 'answer');
  assert.strictEqual(g.ask((t += 100), false), 'answer');
  assert.strictEqual(g.ask((t += 100), false), 'locked'); // 第 4 次被拒：进入歇息
  assert.strictEqual(g.state().strikes, 1);
  assert.strictEqual(g.ask(t + 1000, false), 'wait');
  assert.strictEqual(g.ask(t + 1000, true), 'wait'); // 歇息期内，新请求也不答
  assert.strictEqual(g.ask(t + 59000, false), 'wait');
  // 1 分钟后：只试 1 次
  t += 60000;
  assert.strictEqual(g.ask(t, false), 'answer');
  assert.strictEqual(g.ask(t + 200, false), 'locked');
  assert.strictEqual(g.state().strikes, 2);
  assert.strictEqual(g.ask(t + 200 + 119000, false), 'wait'); // 这次歇 2 分钟
  t += 200 + 120000;
  assert.strictEqual(g.ask(t, false), 'answer');
  assert.strictEqual(g.ask(t + 200, false), 'locked');
  assert.strictEqual(g.ask(t + 200 + 299000, false), 'wait'); // 这次歇 5 分钟
  t += 200 + 300000;
  assert.strictEqual(g.ask(t, false), 'answer');
  assert.strictEqual(g.ask(t + 200, false), 'locked');
  assert.strictEqual(g.ask(t + 200 + 299000, false), 'wait'); // 之后一直是 5 分钟
  // 有一次成功了：恢复正常
  t += 200 + 300000;
  assert.strictEqual(g.ask(t, false), 'answer');
  g.ok();
  assert.deepStrictEqual(g.state(), { strikes: 0, lockUntil: 0 });
  assert.strictEqual(g.ask(t + 100, false), 'answer');
  assert.strictEqual(g.ask(t + 200, false), 'answer');
  assert.strictEqual(g.ask(t + 300, false), 'answer');
});

test('代理验证：不知道是不是第一次问（老内核不给这个信息）时，按“被拒后再问”算，不会无限答下去', () => {
  const g = createAuthGate();
  let n = 0;
  for (let i = 0; i < 50; i++) if (g.ask(i * 10, undefined) === 'answer') n++;
  assert.strictEqual(n, 3);
});

test('代理验证：保险——10 秒内答了 20 次（不管内核说是不是第一次）就先停', () => {
  const g = createAuthGate();
  const r = [];
  for (let i = 0; i < 25; i++) r.push(g.ask(i * 100, true));
  assert.strictEqual(r.filter((x) => x === 'answer').length, 20);
  assert.strictEqual(r[20], 'locked');
  assert.strictEqual(r[21], 'wait');
});

test('日志限量：每个账号每小时最多 N 条，多的只计数；到下一个小时补报“有几条没记”', () => {
  const b = createLogBudget(3, 3600000);
  assert.deepStrictEqual([1, 2, 3, 4, 5].map((i) => b.take('A', i)), [true, true, true, false, false]);
  assert.strictEqual(b.take('B', 6), true); // 别的账号不受影响
  assert.strictEqual(b.dropped('A', 7), 0); // 这个小时还没过完：不补报
  // 下一个小时
  assert.strictEqual(b.dropped('A', 3600001), 2);
  assert.strictEqual(b.dropped('A', 3600002), 0); // 只报一次
  assert.strictEqual(b.take('A', 3600003), true);
});

test('错误码归类：代理 / 证书 / 网络 / 其它', () => {
  assert.strictEqual(failKind(-130, 'ERR_PROXY_CONNECTION_FAILED'), 'proxy');
  assert.strictEqual(failKind(-111, 'ERR_TUNNEL_CONNECTION_FAILED'), 'proxy');
  assert.strictEqual(failKind(-202, 'ERR_CERT_AUTHORITY_INVALID'), 'cert');
  assert.strictEqual(failKind(-106, 'ERR_INTERNET_DISCONNECTED'), 'net');
  assert.strictEqual(failKind(-105, 'ERR_NAME_NOT_RESOLVED'), 'net');
  assert.strictEqual(failKind(-7, 'ERR_TIMED_OUT'), 'net');
  assert.strictEqual(failKind(-101, 'ERR_CONNECTION_RESET'), 'net');
  assert.strictEqual(failKind(-2, 'ERR_FAILED'), 'other');
  assert.strictEqual(failKind(undefined, undefined), 'other');
});

test('只认聊天网站自己的地址（本身或子域名）；长得像的别的网站不算', () => {
  assert.strictEqual(siteHost('wss://web.whatsapp.com/ws/chat', ['web.whatsapp.com']), 'web.whatsapp.com');
  assert.strictEqual(siteHost('wss://kws2.web.telegram.org/apiws', ['web.telegram.org']), 'kws2.web.telegram.org');
  assert.strictEqual(siteHost('wss://web.whatsapp.com.evil.example/ws', ['web.whatsapp.com']), '');
  assert.strictEqual(siteHost('wss://notweb.whatsapp.com/ws', ['web.whatsapp.com']), '');
  assert.strictEqual(siteHost('wss://evil.example/web.whatsapp.com', ['web.whatsapp.com']), '');
  assert.strictEqual(siteHost('not a url', ['web.whatsapp.com']), '');
  assert.strictEqual(siteHost('wss://WEB.WhatsApp.com/ws', ['web.whatsapp.com']), 'web.whatsapp.com');
});
