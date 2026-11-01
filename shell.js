'use strict';
const api = window.shellApi;
const $ = (id) => document.getElementById(id);

let state = { accounts: [], activeId: null };
let editing = null; // null = 添加；否则是账号 id
let deleteArmed = false;

function errText(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function initial(name) {
  const s = String(name || '?').trim();
  const m = s.match(/\d+$/);
  return m && m[0].length <= 2 ? m[0] : s.slice(0, 1).toUpperCase();
}

function render() {
  const list = $('list');
  list.innerHTML = '';
  state.accounts.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'acc' + (a.id === state.activeId ? ' active' : '');
    el.style.background = a.color;
    el.textContent = initial(a.name);
    el.dataset.id = a.id;
    if (a.unread > 0) {
      const b = document.createElement('div');
      b.className = 'badge';
      b.textContent = a.unread > 99 ? '99+' : String(a.unread);
      el.appendChild(b);
    }
    const net = document.createElement('div');
    const on = a.proxy && a.proxy.type !== 'none';
    net.className = 'net' + (on ? (a.ip && a.ip.error ? ' err' : ' on') : '');
    el.appendChild(net);
    if (i < 9) {
      const idx = document.createElement('div');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      el.appendChild(idx);
    }
    el.addEventListener('click', () => api.switchTo(a.id));
    el.addEventListener('dblclick', () => openEditor(a.id));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openEditor(a.id);
    });
    el.addEventListener('mouseenter', () => showTip(el, a, i));
    el.addEventListener('mouseleave', hideTip);
    list.appendChild(el);
  });
}

function showTip(el, a, i) {
  const r = el.getBoundingClientRect();
  let ip = '出口 IP：未检测';
  if (a.ip && a.ip.ip) ip = '出口 IP：' + a.ip.ip + (a.ip.place ? '（' + a.ip.place + '）' : '');
  else if (a.ip && a.ip.error) ip = '代理异常：' + a.ip.error;
  const lines = [a.name + (i < 9 ? '   Ctrl+' + (i + 1) : ''), '代理：' + a.proxyLabel];
  if (a.proxy && a.proxy.type !== 'none') lines.push(ip);
  lines.push('右键或双击：编辑 / 设置代理');
  const tip = $('tip');
  tip.textContent = lines.join('\n');
  tip.style.top = Math.max(6, r.top) + 'px';
  tip.style.display = 'block';
}
function hideTip() {
  $('tip').style.display = 'none';
}

// ---------- 编辑框 ----------
function setResult(text, cls) {
  const r = $('result');
  r.textContent = text || '';
  r.className = cls || '';
}

function syncFields() {
  const t = $('m-type').value;
  $('proxy-fields').style.display = t === 'none' ? 'none' : 'block';
  $('m-hint').style.color = t.startsWith('socks') && ($('m-user').value || $('m-pass').value) ? '#c62828' : '';
}

function readForm() {
  const type = $('m-type').value;
  return {
    name: $('m-name').value.trim(),
    proxy:
      type === 'none'
        ? { type: 'none' }
        : { type, host: $('m-host').value.trim(), port: $('m-port').value.trim(), username: $('m-user').value.trim(), password: $('m-pass').value },
  };
}

async function openEditor(id) {
  hideTip();
  editing = id || null;
  deleteArmed = false;
  $('m-delete').textContent = '删除这个账号';
  const a = state.accounts.find((x) => x.id === id);
  $('m-title').textContent = a ? '编辑账号：' + a.name : '添加账号';
  $('m-name').value = a ? a.name : '';
  $('m-paste').value = '';
  const p = (a && a.proxy) || { type: 'none' };
  $('m-type').value = p.type || 'none';
  $('m-host').value = p.host || '';
  $('m-port').value = p.port || '';
  $('m-user').value = p.username || '';
  $('m-pass').value = '';
  $('m-pass').placeholder = a && p.hasPassword ? '已保存（不修改请留空）' : '';
  $('m-edit-extra').style.display = a ? 'block' : 'none';
  $('m-save').textContent = a ? '保存' : '添加账号';
  setResult(a && a.ip ? (a.ip.ip ? '当前出口 IP：' + a.ip.ip + (a.ip.place ? '（' + a.ip.place + '）' : '') : '代理异常：' + a.ip.error) : '', a && a.ip ? (a.ip.ip ? 'ok' : 'err') : '');
  syncFields();
  await api.setOverlay(true);
  $('modal').classList.add('show');
  $('m-name').focus();
}

async function closeEditor() {
  $('modal').classList.remove('show');
  editing = null;
  await api.setOverlay(false);
}

$('m-type').addEventListener('change', syncFields);
$('m-user').addEventListener('input', syncFields);
$('m-pass').addEventListener('input', syncFields);

$('m-parse').addEventListener('click', async () => {
  const curType = $('m-type').value;
  const p = await api.parseProxy($('m-paste').value, curType === 'none' ? 'http' : curType);
  if (!p) return setResult('没能识别这个代理链接，请检查格式，或者手动填写下面的地址和端口', 'err');
  $('m-type').value = p.type;
  $('m-host').value = p.host;
  $('m-port').value = p.port;
  $('m-user').value = p.username || '';
  $('m-pass').value = p.password || '';
  syncFields();
  setResult('已识别：' + p.type.toUpperCase() + ' ' + p.host + ':' + p.port + (p.username ? '（带用户名密码）' : ''), 'ok');
});

$('m-test').addEventListener('click', async () => {
  const f = readForm();
  if (f.proxy.type === 'none') return setResult('当前选择的是直连，不需要测试', '');
  const btn = $('m-test');
  btn.disabled = true;
  setResult('正在通过代理连接…（最多约 15 秒）', '');
  try {
    // 编辑时密码留空 = 沿用已保存的密码
    const r = await api.testProxy(f.proxy, editing);
    setResult('✓ 代理可用，出口 IP：' + r.ip + (r.place ? '（' + r.place + '）' : ''), 'ok');
  } catch (e) {
    setResult('✗ ' + errText(e), 'err');
  } finally {
    btn.disabled = false;
  }
});

$('m-save').addEventListener('click', async () => {
  const f = readForm();
  const btn = $('m-save');
  btn.disabled = true;
  try {
    if (editing) await api.update(editing, f);
    else await api.add(f);
    await closeEditor();
  } catch (e) {
    setResult('✗ ' + errText(e), 'err');
  } finally {
    btn.disabled = false;
  }
});

$('m-cancel').addEventListener('click', closeEditor);
$('m-up').addEventListener('click', () => editing && api.move(editing, -1));
$('m-down').addEventListener('click', () => editing && api.move(editing, 1));
$('m-reload').addEventListener('click', async () => {
  if (editing) await api.reload(editing);
  setResult('已重新加载', 'ok');
});
$('m-delete').addEventListener('click', async () => {
  if (!editing) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $('m-delete').textContent = '确定删除？再点一次';
    return;
  }
  try {
    await api.remove(editing);
    await closeEditor();
  } catch (e) {
    setResult('✗ ' + errText(e), 'err');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modal').classList.contains('show')) closeEditor();
});

$('add').addEventListener('click', () => openEditor(null));
$('settings').addEventListener('click', () => api.openSettings());

api.onState((s) => {
  state = s;
  render();
});
api.getState().then((s) => {
  state = s;
  render();
});
