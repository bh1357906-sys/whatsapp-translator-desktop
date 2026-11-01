'use strict';
const api = window.shellApi;
const $ = (id) => document.getElementById(id);
const I18N = window.TRX_I18N;
const T = I18N.T;

let state = { accounts: [], groups: [], activeId: null };
let editingGroup = null;
let editing = null; // null = 添加；否则是账号 id
let deleteArmed = false;
let lastGroup = ''; // 连续添加账号时，默认放进上一次选的分组

function errText(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function initial(name) {
  const s = String(name || '?').trim();
  const m = s.match(/\d+$/);
  return m && m[0].length <= 2 ? m[0] : s.slice(0, 1).toUpperCase();
}

function accEl(a, i) {
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
  return el;
}

function groupEl(g, members) {
  const el = document.createElement('div');
  el.className = 'grp' + (g.collapsed && members.some((a) => a.id === state.activeId) ? ' has-active' : '');
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = g.collapsed ? '▸' : '▾';
  el.appendChild(arrow);
  el.appendChild(document.createTextNode(g.name));
  const cnt = document.createElement('span');
  cnt.className = 'cnt';
  cnt.textContent = T('{0} 个', members.length);
  el.appendChild(cnt);
  const unread = members.reduce((n, a) => n + (a.unread || 0), 0);
  if (g.collapsed && unread > 0) {
    const b = document.createElement('div');
    b.className = 'badge';
    b.textContent = unread > 99 ? '99+' : String(unread);
    el.appendChild(b);
  }
  el.title = T('{0}（{1} 个账号）\n点击：展开 / 收起\n右键或双击：改名、排序、删除分组', g.name, members.length);
  el.addEventListener('click', () => api.groupCollapse(g.name, !g.collapsed));
  el.addEventListener('dblclick', () => openGroupEditor(g.name));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openGroupEditor(g.name);
  });
  return el;
}

function render() {
  const list = $('list');
  list.innerHTML = '';
  const groups = state.groups || [];
  // state.accounts 已经按显示顺序排好（未分组在前，然后各分组）；序号 = Ctrl+数字
  const indexOf = new Map(state.accounts.map((a, i) => [a.id, i]));
  state.accounts.filter((a) => !a.group).forEach((a) => list.appendChild(accEl(a, indexOf.get(a.id))));
  groups.forEach((g) => {
    const members = state.accounts.filter((a) => a.group === g.name);
    list.appendChild(groupEl(g, members));
    if (!g.collapsed) members.forEach((a) => list.appendChild(accEl(a, indexOf.get(a.id))));
  });
  const dl = $('m-groups');
  dl.innerHTML = '';
  groups.forEach((g) => {
    const o = document.createElement('option');
    o.value = g.name;
    dl.appendChild(o);
  });
}

function showTip(el, a, i) {
  const r = el.getBoundingClientRect();
  let ip = T('出口 IP：未检测');
  if (a.ip && a.ip.ip) ip = T('出口 IP：') + a.ip.ip + (a.ip.place ? T('（') + a.ip.place + T('）') : '');
  else if (a.ip && a.ip.error) ip = T('代理异常：') + a.ip.error;
  const lines = [a.name + (i < 9 ? '   Ctrl+' + (i + 1) : ''), T('代理：') + a.proxyLabel];
  if (a.group) lines.splice(1, 0, T('分组：') + a.group);
  if (a.proxy && a.proxy.type !== 'none') lines.push(ip);
  lines.push(T('右键或双击：编辑 / 设置代理'));
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
    group: $('m-group').value.trim(),
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
  $('m-delete').textContent = T('删除这个账号');
  const a = state.accounts.find((x) => x.id === id);
  $('m-title').textContent = a ? T('编辑账号：') + a.name : T('添加账号');
  $('m-name').value = a ? a.name : '';
  $('m-group').value = a ? a.group || '' : lastGroup;
  $('m-paste').value = '';
  const p = (a && a.proxy) || { type: 'none' };
  $('m-type').value = p.type || 'none';
  $('m-host').value = p.host || '';
  $('m-port').value = p.port || '';
  $('m-user').value = p.username || '';
  $('m-pass').value = '';
  $('m-pass').placeholder = a && p.hasPassword ? T('已保存（不修改请留空）') : '';
  $('m-edit-extra').style.display = a ? 'block' : 'none';
  $('m-save').textContent = a ? T('保存') : T('添加账号');
  setResult(a && a.ip ? (a.ip.ip ? T('当前出口 IP：') + a.ip.ip + (a.ip.place ? T('（') + a.ip.place + T('）') : '') : T('代理异常：') + a.ip.error) : '', a && a.ip ? (a.ip.ip ? 'ok' : 'err') : '');
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
  if (!p) return setResult(T('没能识别这个代理链接，请检查格式，或者手动填写下面的地址和端口'), 'err');
  $('m-type').value = p.type;
  $('m-host').value = p.host;
  $('m-port').value = p.port;
  $('m-user').value = p.username || '';
  $('m-pass').value = p.password || '';
  syncFields();
  setResult(T('已识别：') + p.type.toUpperCase() + ' ' + p.host + ':' + p.port + (p.username ? T('（带用户名密码）') : ''), 'ok');
});

$('m-test').addEventListener('click', async () => {
  const f = readForm();
  if (f.proxy.type === 'none') return setResult(T('当前选择的是直连，不需要测试'), '');
  const btn = $('m-test');
  btn.disabled = true;
  setResult(T('正在通过代理连接…（最多约 15 秒）'), '');
  try {
    // 编辑时密码留空 = 沿用已保存的密码
    const r = await api.testProxy(f.proxy, editing);
    setResult(T('✓ 代理可用，出口 IP：') + r.ip + (r.place ? T('（') + r.place + T('）') : ''), 'ok');
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
    else {
      await api.add(f);
      lastGroup = f.group;
    }
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
  setResult(T('已重新加载'), 'ok');
});
$('m-delete').addEventListener('click', async () => {
  if (!editing) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $('m-delete').textContent = T('确定删除？再点一次');
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
  if (e.key === 'Escape' && $('gmodal').classList.contains('show')) closeGroupEditor();
});

$('add').addEventListener('click', () => openEditor(null));
$('addgroup').addEventListener('click', () => openGroupEditor(null));

// ---------- 分组编辑框 ----------
let gDeleteArmed = false;
async function openGroupEditor(name) {
  hideTip();
  editingGroup = name;
  gDeleteArmed = false;
  $('g-delete').textContent = T('删除分组（账号保留，变成未分组）');
  $('g-title').textContent = name ? T('分组：') + name : T('新建分组');
  $('g-name').value = name || '';
  $('g-result').textContent = '';
  $('g-edit-extra').style.display = name ? 'block' : 'none';
  await api.setOverlay(true);
  $('gmodal').classList.add('show');
  $('g-name').focus();
}
async function closeGroupEditor() {
  $('gmodal').classList.remove('show');
  editingGroup = null;
  await api.setOverlay(false);
}
$('g-cancel').addEventListener('click', closeGroupEditor);
$('g-save').addEventListener('click', async () => {
  const v = $('g-name').value.trim();
  try {
    if (editingGroup) await api.groupRename(editingGroup, v);
    else await api.groupAdd(v);
    await closeGroupEditor();
  } catch (e) {
    $('g-result').textContent = '✗ ' + errText(e);
  }
});
$('g-up').addEventListener('click', () => editingGroup && api.groupMove(editingGroup, -1));
$('g-down').addEventListener('click', () => editingGroup && api.groupMove(editingGroup, 1));
$('g-delete').addEventListener('click', async () => {
  if (!editingGroup) return;
  if (!gDeleteArmed) {
    gDeleteArmed = true;
    $('g-delete').textContent = T('确定删除这个分组？再点一次');
    return;
  }
  await api.groupRemove(editingGroup);
  await closeGroupEditor();
});
$('g-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('g-save').click();
});
$('settings').addEventListener('click', () => api.openSettings());

// ---------- 界面语言 ----------
function applyUiLang(l) {
  I18N.setLang(l);
  I18N.localizeDom(document.body);
  render();
}
api.getUiLang().then(applyUiLang).catch(() => {});
api.onUiLang(applyUiLang);

api.onState((s) => {
  state = s;
  render();
});
api.getState().then((s) => {
  state = s;
  render();
});
