// Wingman（聊天助手）页面部分：💬 按钮 + 面板
'use strict';

const RELATION_MODES = [
  { key: 'dating', short: '追', title: '追女生' },
  { key: 'friend', short: '友', title: '普通朋友' },
  { key: 'business', short: '商', title: '商务' },
];

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\-().+]/g, '');
}
function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function installWingman(ui) {
  const ipc = ui.ipc;
  const esc = ui.escapeHtml;
  let target = '';
  let relationType = 'dating';
  let instruction = '';
  const recent = []; // 本次运行中目标聊天的消息
  const seenIds = new Set();
  let chatOpenedAt = Date.now();
  let badge = null;
  let fab = null;

  function isTarget(chat) {
    if (!target || !chat) return false;
    if (chat.key && chat.key === target) return true;
    if (chat.name && norm(chat.name) === norm(target)) return true;
    const t = digits(target);
    const n = digits(chat.number);
    if (t.length >= 7 && n.length >= 7 && (t.endsWith(n) || n.endsWith(t))) return true;
    return false;
  }

  ui.onChatChange(() => {
    chatOpenedAt = Date.now();
  });

  // 每次扫描都会回调；按消息 id 去重，主进程再做一次持久去重
  ui.onMessage((info) => {
    if (!target) return;
    const chat = { key: info.chatKey, name: info.chatName, number: ui.getChat().number };
    if (!isTarget(chat)) return;
    const id = info.id || (info.incoming ? 'in:' : 'out:') + info.text;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const role = info.incoming ? 'her' : 'me';
    recent.push({ id, role, text: info.text });
    if (recent.length > 80) recent.shift();
    // 打开聊天 4 秒内看到的、或不在最底部的，都算历史补记
    const backfill = Date.now() - chatOpenedAt < 4000 || !info.isNewest;
    if (info.incoming && !backfill) showBadge();
    ipc.invoke('wm:log', { chat: target, id, role, text: info.text, backfill }).catch(() => {});
  });

  function showBadge() {
    if (!fab || badge || ui.isOpen(panel)) return;
    badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;top:-2px;right:-2px;width:12px;height:12px;border-radius:50%;background:#f00;border:2px solid #fff;';
    fab.appendChild(badge);
  }
  function clearBadge() {
    if (badge) badge.remove();
    badge = null;
  }

  const panel = ui.createPanel('trx-wing-panel');
  panel.style.padding = '0';

  function msgBox(html, color) {
    return '<div style="padding:16px;color:' + (color || '#667781') + ';text-align:center;white-space:pre-wrap">' + html + '</div>';
  }
  function errMsg(err) {
    const m = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return m.includes('NO_KEY') ? '未配置 API Key（点 ⚙ 设置）' : m.slice(0, 220);
  }

  function render() {
    const mode = RELATION_MODES.find((x) => x.key === relationType) || RELATION_MODES[0];
    panel.innerHTML = `
      <div class="trx-h">
        <div style="min-width:0">
          <div>聊天助手</div>
          <div class="trx-sub" id="wm-target">${target ? '目标：' + esc(target) : '<span style="color:#d32f2f">未设置目标（不记录任何聊天）</span>'}</div>
        </div>
        <button class="trx-btn" id="wm-mode" title="关系类型：${esc(mode.title)}（点击切换）" style="background:#6d3b8f;color:#fff;border:none;font-weight:700">${esc(mode.short)}</button>
      </div>
      <div style="padding:8px 14px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #eee">
        <button class="trx-btn trx-primary" id="wm-cur" title="把当前打开的聊天设为目标">设为当前聊天</button>
        <button class="trx-btn" id="wm-set">手动填</button>
        <button class="trx-btn" id="wm-profile">档案</button>
        <button class="trx-btn" id="wm-review">复盘</button>
        <button class="trx-btn" id="wm-clear" title="取消目标，停止记录">停用</button>
      </div>
      <div id="wm-setrow" style="display:none;padding:8px 14px;border-bottom:1px solid #eee">
        <div style="display:flex;gap:6px"><input class="trx-input" id="wm-target-input" placeholder="联系人名字或电话号码" value="${esc(target)}"><button class="trx-btn trx-primary" id="wm-target-save">保存</button></div>
      </div>
      <div style="padding:8px 14px;border-bottom:1px solid #eee">
        <input class="trx-input" id="wm-instr" placeholder="要求（可选）：简短点 / 幽默点 / 别太主动…" value="${esc(instruction)}">
      </div>
      <div id="wm-profile-sec" style="display:none;padding:8px 14px;border-bottom:1px solid #eee">
        <input type="file" id="wm-file" accept=".txt,text/plain" style="display:none">
        <button class="trx-btn trx-primary" id="wm-import">导入聊天记录（WhatsApp 导出的 .txt）</button>
        <div id="wm-profile-body" style="margin-top:8px;font-size:12px;line-height:1.5"></div>
      </div>
      <div id="wm-body" style="padding:10px 14px"></div>`;
    const $ = (id) => panel.querySelector('#' + id);
    const body = $('wm-body');

    $('wm-mode').onclick = async () => {
      const i = RELATION_MODES.findIndex((x) => x.key === relationType);
      relationType = RELATION_MODES[(i + 1) % RELATION_MODES.length].key;
      await ipc.invoke('tr:patch-settings', { relationType });
      render();
    };
    $('wm-set').onclick = () => {
      const r = $('wm-setrow');
      r.style.display = r.style.display === 'none' ? 'block' : 'none';
    };
    $('wm-cur').onclick = async () => {
      const c = ui.getChat();
      if (!c.key) return ui.toast('请先打开要设为目标的聊天', 'warn');
      await setTarget(c.name || c.key);
    };
    $('wm-target-save').onclick = () => setTarget($('wm-target-input').value.trim());
    $('wm-clear').onclick = () => setTarget('');
    $('wm-instr').onchange = async (e) => {
      instruction = e.target.value.trim();
      await ipc.invoke('tr:patch-settings', { wingmanInstruction: instruction });
    };
    $('wm-profile').onclick = async () => {
      const sec = $('wm-profile-sec');
      const show = sec.style.display === 'none';
      sec.style.display = show ? 'block' : 'none';
      if (!show) return;
      const pb = $('wm-profile-body');
      if (!target) return (pb.innerHTML = '<span style="color:#667781">先设置目标，再导入记录生成档案。</span>');
      renderProfile(pb, await ipc.invoke('wm:get-profile', target));
    };
    $('wm-import').onclick = () => $('wm-file').click();
    $('wm-file').onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      const pb = $('wm-profile-body');
      if (!file) return;
      if (!target) return (pb.innerHTML = '<span style="color:#d32f2f">请先设置目标</span>');
      pb.innerHTML = '<span style="color:#667781">正在通读聊天记录、生成档案…（可能要 1 分钟）</span>';
      try {
        const text = await file.text();
        renderProfile(pb, await ipc.invoke('wm:build-profile', { chat: target, text }));
      } catch (err) {
        pb.innerHTML = '<span style="color:#c00">生成失败：' + esc(errMsg(err)) + '</span>';
      }
      e.target.value = '';
    };
    $('wm-review').onclick = async () => {
      if (!target) return (body.innerHTML = msgBox('先设置目标。'));
      body.innerHTML = msgBox('复盘分析中…');
      try {
        const res = await ipc.invoke('wm:review', { chat: target, messages: recentPlain(40) });
        let h = '<div style="font-weight:700;margin-bottom:8px">复盘</div>';
        if (res.good) h += '<div style="color:#2e7d32;margin-bottom:6px"><b>做得好：</b>' + esc(res.good) + '</div>';
        if (res.bad) h += '<div style="color:#c62828;margin-bottom:6px"><b>要改：</b>' + esc(res.bad) + '</div>';
        if (res.next) h += '<div style="background:#fff8e1;padding:8px;border-radius:8px"><b>下一步：</b>' + esc(res.next) + '</div>';
        body.innerHTML = h;
      } catch (err) {
        body.innerHTML = msgBox('复盘失败：' + esc(errMsg(err)), '#c00');
      }
    };
    return body;
  }

  function recentPlain(n) {
    return recent.slice(-n).map((m) => ({ role: m.role, text: m.text }));
  }

  async function setTarget(t) {
    target = t;
    await ipc.invoke('tr:patch-settings', { wingmanTarget: target });
    seenIds.clear();
    recent.length = 0;
    chatOpenedAt = Date.now(); // 设目标时屏幕上已有的消息按历史补记
    const body = render();
    if (target) runSuggest(body, false);
    else body.innerHTML = msgBox('已停用，不再记录任何聊天。');
  }

  function renderProfile(el, p) {
    if (!p) return (el.innerHTML = '<span style="color:#667781">还没有档案。点「导入聊天记录」，选择 WhatsApp 导出的 txt。</span>');
    const labels = {
      summary: '概括',
      personality: '性格',
      interests: '兴趣',
      habits: '生活习惯',
      communication: '沟通风格',
      topicsLikes: '喜欢的话题',
      topicsAvoid: '回避的话题',
      attitudeTowardYou: '对你的态度',
      notes: '注意事项',
    };
    let h = '';
    Object.keys(labels).forEach((k) => {
      if (p[k]) h += '<div style="margin-bottom:6px"><b>' + labels[k] + '：</b>' + esc(p[k]) + '</div>';
    });
    el.innerHTML = h || '<span style="color:#667781">档案为空。</span>';
  }

  async function runSuggest(body, vary) {
    if (!target) return (body.innerHTML = msgBox('先点「设为当前聊天」或「手动填」设置目标。\n未设置前不记录、不分析任何聊天。'));
    const chat = ui.getChat();
    if (!isTarget(chat)) return (body.innerHTML = msgBox('当前聊天不是目标（' + esc(target) + '）。\n请打开目标的聊天再点 💬。'));
    const msgs = recentPlain(25);
    body.innerHTML = msgBox('分析中…');
    try {
      const res = await ipc.invoke('wm:suggest', {
        chat: target,
        messages: msgs,
        theirLang: chat.lang,
        vary: !!vary,
        instruction: (panel.querySelector('#wm-instr') || {}).value || instruction,
      });
      renderSuggest(body, res);
    } catch (err) {
      body.innerHTML = msgBox('分析失败：' + esc(errMsg(err)), '#c00');
    }
  }

  function renderSuggest(body, res) {
    let h = '';
    if (res.interest !== undefined) {
      const color = { low: '#d32f2f', medium: '#f59e0b', high: '#2e7d32' }[res.interest] || '#999';
      const label = { low: '低', medium: '中', high: '高' }[res.interest] || res.interest;
      const trend = { rising: '上升', stable: '平稳', falling: '下降' }[res.trend] || '';
      h += '<div style="font-size:15px;font-weight:700">热度：<span style="color:' + color + '">' + esc(label) + '</span>' + (trend ? ' <span style="font-size:12px;color:#667781;font-weight:400">（' + esc(trend) + '）</span>' : '') + '</div>';
      if (res.stage) h += '<div style="font-size:12px;color:#667781;margin-top:2px">阶段：' + esc(res.stage) + '</div>';
      if (res.read) h += '<div style="margin:8px 0">' + esc(res.read) + '</div>';
    } else if (res.tone) {
      h += '<div style="margin-bottom:8px">' + esc(res.tone) + '</div>';
    }
    h += '<div style="font-weight:700;margin:8px 0;display:flex;justify-content:space-between;align-items:center"><span>可选回复（点一下填入输入框）</span><button class="trx-btn" id="wm-refresh">🔄 换一批</button></div>';
    (res.replies || []).forEach((r, i) => {
      const text = typeof r === 'string' ? r : r.text;
      const zh = typeof r === 'string' ? '' : r.zh || '';
      if (!text) return;
      h += '<div class="wm-reply" data-i="' + i + '" style="padding:9px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;cursor:pointer;background:#f7f9fa">';
      h += '<div style="font-size:14px">' + esc(text) + '</div>';
      if (zh) h += '<div style="font-size:12px;color:#667781;margin-top:4px">' + esc(zh) + '</div>';
      h += '</div>';
    });
    if (res.advice) h += '<div style="margin-top:6px;background:#fff8e1;padding:8px;border-radius:8px">' + esc(res.advice) + '</div>';
    if (res.cadence) h += '<div style="margin-top:6px;background:#e8f5e9;padding:8px;border-radius:8px">' + esc(res.cadence) + '</div>';
    body.innerHTML = h;
    body.querySelector('#wm-refresh').onclick = () => runSuggest(body, true);
    body.querySelectorAll('.wm-reply').forEach((el) => {
      el.onclick = async () => {
        const r = res.replies[+el.dataset.i];
        const text = typeof r === 'string' ? r : r.text;
        ui.closePanel(panel);
        await ui.fillComposer(text);
      };
    });
  }

  ui.onReady((s) => {
    target = s.wingmanTarget || '';
    relationType = s.relationType || 'dating';
    instruction = s.wingmanInstruction || '';
    fab = ui.addFab({
      id: 'trx-wing-fab',
      text: '💬',
      title: '聊天助手：分析对方态度 + 拟几条回复',
      color: '#d43f81',
      onClick: () => {
        const body = render();
        const open = ui.togglePanel(panel);
        if (open) {
          clearBadge();
          runSuggest(body, false);
        }
      },
    });
    fab.style.fontSize = '18px';
  });
}

module.exports = { installWingman };
