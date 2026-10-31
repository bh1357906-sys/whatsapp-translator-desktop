// Wingman（聊天助手）服务：聊天记忆、关系状态、人物档案、建议、复盘
// 与运行环境无关：桌面版用文件保存，Chrome 插件用 chrome.storage 保存。
'use strict';

const WINGMAN_DEFAULTS = {
  wingmanTarget: '',
  relationType: 'dating',
  wingmanInstruction: '',
};
const WINGMAN_PAGE_KEYS = ['wingmanTarget', 'relationType', 'wingmanInstruction'];

const MAX_MSGS_PER_CHAT = 400;

function defaultState() {
  return { stage: '未知', interestHistory: [], lastIncomingTs: 0, lastOutgoingTs: 0, messageCount: 0, openThreads: [] };
}

function fmtAgo(ms) {
  if (ms < 60000) return '不到1分钟';
  if (ms < 3600000) return Math.round(ms / 60000) + '分钟';
  if (ms < 86400000) return Math.round(ms / 3600000) + '小时';
  return Math.round(ms / 86400000) + '天';
}

// kv 需要提供（都返回 Promise）：
//   readLog() → [{ts, chat, id, role, text}]   appendLog(entry)
//   get(name, fallback)                        set(name, value)
function createWingman({ service, kv }) {
  const callLLM = (opts) => service.callLLM(opts, 'high');
  const parseJSON = service.parseJSON;
  const handlers = {};

  // 聊天记录索引：第一次用到时读一次，之后全在内存里
  let indexPromise = null;
  let index = null; // chat → { ids:Set, msgs:[{role,text,ts}] }
  function bucketFor(chat) {
    let b = index.get(chat);
    if (!b) {
      b = { ids: new Set(), msgs: [] };
      index.set(chat, b);
    }
    return b;
  }
  function getIndex() {
    if (!indexPromise) {
      indexPromise = (async () => {
        index = new Map();
        const entries = (await kv.readLog().catch(() => [])) || [];
        for (const m of entries) {
          if (!m || !m.chat || !m.text) continue;
          const bucket = bucketFor(m.chat);
          const id = m.id || m.role + '::' + m.text;
          if (bucket.ids.has(id)) continue;
          bucket.ids.add(id);
          bucket.msgs.push({ role: m.role, text: m.text, ts: m.ts || 0 });
          if (bucket.msgs.length > MAX_MSGS_PER_CHAT) bucket.msgs.shift();
        }
        return index;
      })();
    }
    return indexPromise;
  }

  let states = null;
  async function loadStates() {
    if (!states) states = (await kv.get('wingman-state', {})) || {};
    return states;
  }
  let stateTimer = null;
  function saveStatesSoon() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      kv.set('wingman-state', states).catch(() => {});
    }, 1500);
  }
  async function getState(chat) {
    const st = await loadStates();
    if (!st[chat]) st[chat] = defaultState();
    return st[chat];
  }

  async function loadProfiles() {
    return (await kv.get('wingman-profiles', {})) || {};
  }

  async function history(chat, extra, limit) {
    await getIndex();
    const b = index.get(chat);
    const msgs = b ? b.msgs.map((m) => ({ role: m.role, text: m.text })) : [];
    const seen = new Set(msgs.slice(-80).map((m) => m.role + '::' + m.text));
    (extra || []).forEach((m) => {
      const k = m.role + '::' + m.text;
      if (!seen.has(k)) {
        msgs.push({ role: m.role, text: m.text });
        seen.add(k);
      }
    });
    return msgs.slice(-limit);
  }

  function convoText(msgs) {
    return msgs.map((m) => (m.role === 'me' ? '我' : '对方') + '：' + m.text).join('\n');
  }

  handlers['wm:log'] = async (entry) => {
    if (!entry || !entry.chat || !entry.text) return false;
    await getIndex();
    const b = bucketFor(entry.chat);
    const id = entry.id || entry.role + '::' + entry.text;
    if (b.ids.has(id)) return false;
    b.ids.add(id);
    const ts = Date.now();
    b.msgs.push({ role: entry.role, text: entry.text, ts });
    if (b.msgs.length > MAX_MSGS_PER_CHAT) b.msgs.shift();
    kv.appendLog({ ts, chat: entry.chat, id, role: entry.role, text: entry.text }).catch(() => {});
    const st = await getState(entry.chat);
    st.messageCount = (st.messageCount || 0) + 1;
    // 只有“刚刚出现的新消息”才更新时间；打开聊天时补记的历史消息不算
    if (!entry.backfill) {
      if (entry.role === 'her') st.lastIncomingTs = ts;
      else st.lastOutgoingTs = ts;
    }
    saveStatesSoon();
    return true;
  };

  handlers['wm:get-profile'] = async (chat) => (await loadProfiles())[chat] || null;
  handlers['wm:get-state'] = async (chat) => ({ ...defaultState(), ...((await loadStates())[chat] || {}) });

  handlers['wm:build-profile'] = async ({ chat, text }) => {
    const content = String(text || '').trim();
    if (!chat) throw new Error('请先设置目标');
    if (!content) throw new Error('文件是空的');
    // 取最近的 4 万字（旧版取的是最早的部分）
    const recent = content.length > 40000 ? content.slice(-40000) : content;
    const prompt = [
      '下面是这个男人和一个他有好感的女人的 WhatsApp 聊天记录（较长时只保留了最近的部分）。请通读，生成一份「人物档案」，帮助他以后更懂她、聊得更自然。',
      '',
      '---聊天记录---',
      recent,
      '---结束---',
      '',
      '只输出 JSON，不要 markdown、不要代码块，严格包含这些键（值都用中文写）：',
      '{',
      '  "summary": "一句话概括她是什么样的人",',
      '  "personality": "性格特征",',
      '  "interests": "兴趣爱好（从聊天里提到的）",',
      '  "habits": "生活习惯 / 日常作息",',
      '  "communication": "沟通风格：语气、消息长短、是否用emoji、正式还是随意、回复快慢、会不会主动反问",',
      '  "topicsLikes": "她愿意聊、会多聊几句的话题",',
      '  "topicsAvoid": "她回避、敷衍、或明显冷场的话题",',
      '  "attitudeTowardYou": "从记录判断她对这个男人的态度（诚实，别粉饰）",',
      '  "notes": "注意事项 / 雷区 / 建议怎么和她相处"',
      '}',
      '',
      '规则：只依据聊天记录里的真实信息，不要编造。没提到的字段就写「未知」。态度判断要诚实，不要因为想安慰他而说好话。',
    ].join('\n');
    const raw = await callLLM({ prompt, timeoutMs: 150000, maxTokens: 2048, retries: 1 });
    const parsed = parseJSON(raw);
    if (!parsed) throw new Error('模型返回的格式不对：' + String(raw || '').slice(0, 120));
    const profiles = await loadProfiles();
    profiles[chat] = parsed;
    await kv.set('wingman-profiles', profiles);
    return parsed;
  };

  handlers['wm:suggest'] = async ({ chat, messages, theirLang, vary, instruction }) => {
    if (!chat) throw new Error('请先设置目标');
    const s = await service.load();
    const target = theirLang || s.defaultTheirLang || 'English';
    const my = s.myLang || 'Simplified Chinese';
    const st = { ...defaultState(), ...((await loadStates())[chat] || {}) };
    const convo = convoText(await history(chat, messages, 100));

    let profileBlock = '';
    const profile = (await loadProfiles())[chat];
    if (profile) profileBlock = '\n你已经有一份对方的档案（来自过往聊天记录的分析，给建议务必贴合）：\n' + JSON.stringify(profile, null, 2);

    const mode = s.relationType || 'dating';
    const varyLine = vary ? '注意：用户对上一版回复不满意，请换一个完全不同的角度、措辞和侧重点，不要重复上一版的思路。' : '';
    const instructLine = instruction ? `用户额外要求（务必遵守）：${instruction}` : '';
    const temperature = vary ? 0.9 : 0.5;
    const replyShape = `  "replies": [ {"text": "用${target}写的候选回复1", "zh": "${my}意思"}, {"text": "候选回复2", "zh": "意思"}, {"text": "候选回复3", "zh": "意思"} ],`;

    if (mode !== 'dating') {
      const modeLabel = mode === 'business' ? '商务' : '朋友';
      const prompt = [
        `你是一个聊天助手，帮用户和对方自然、得体地聊天（${modeLabel}关系，不是恋爱）。读下面的对话，给出回复建议。`,
        '',
        '最近对话（按时间顺序）：',
        '---',
        convo || '（无）',
        '---',
        '',
        `对方的语言是 ${target}，用户的语言是 ${my}。`,
        profileBlock,
        '',
        '只输出 JSON，不要 markdown、不要代码块，严格包含这些键：',
        '{',
        '  "tone": "对方现在的态度：配合/敷衍/友好/冷淡/正常，加一句简短中文说明",',
        replyShape,
        '  "advice": "一句中文建议：怎么接这个话题、注意什么语气"',
        '}',
        '',
        instructLine,
        varyLine,
        '规则：',
        `- 候选回复用自然、口语化的 ${target}，贴合对方说话的语气和用词。`,
        `- 正常得体的${modeLabel}语气，别过度热情、也别生硬。`,
        '- 每条回复不超过 30 个词。',
      ].join('\n');
      const raw = await callLLM({ prompt, temperature, timeoutMs: 60000 });
      const parsed = parseJSON(raw);
      if (!parsed || !Array.isArray(parsed.replies)) throw new Error('模型返回的格式不对：' + String(raw || '').slice(0, 120));
      return parsed;
    }

    const trend = st.interestHistory && st.interestHistory.length ? st.interestHistory.slice(-6).map((h) => h.interest).join(' → ') : '（尚无历史）';
    const now = Date.now();
    const stateBlock = [
      '',
      '关系状态（这是你和她的长期相处记忆，务必结合）：',
      `当前阶段：${st.stage}`,
      `热度历史（旧→新）：${trend}`,
      `她上次回消息：${st.lastIncomingTs ? fmtAgo(now - st.lastIncomingTs) + '前' : '未知'}；他上次发消息：${st.lastOutgoingTs ? fmtAgo(now - st.lastOutgoingTs) + '前' : '未知'}`,
      `累计记录消息数：${st.messageCount}`,
    ].join('\n');

    const prompt = [
      '你是一个陪聊教练，正在帮一个男人和一个他有好感的女人发消息。你有她的长期相处记忆，也看到最近的对话。请据此给出分析和建议。',
      '',
      '最近对话（按时间顺序）：',
      '---',
      convo || '（无）',
      '---',
      '',
      `女人的语言是 ${target}，男人的语言是 ${my}。`,
      profileBlock,
      stateBlock,
      '',
      '只输出 JSON，不要 markdown、不要代码块，严格包含这些键：',
      '{',
      '  "interest": "low | medium | high 三选一（当下）",',
      '  "trend": "rising | stable | falling 三选一（对照热度历史判断走向）",',
      '  "stage": "破冰 | 熟络 | 试探 | 邀约 | 见面（当前关系阶段）",',
      '  "read": "2-3 句中文评估：她热不热情、会不会主动反问、对话题开不开放。诚实，别粉饰。",',
      replyShape,
      '  "advice": "一句中文建议：继续聊、缓一缓、还是该约见面，给一个具体下一步。",',
      '  "cadence": "一句中文：现在该不该主动找她、隔多久再聊合适（结合她上次回消息的时间）。"',
      '}',
      '',
      instructLine,
      varyLine,
      '回复规则：',
      `- 候选回复用自然、口语化的 ${target}，贴合她说话的语气和用词风格。`,
      '- 每条候选回复是独立完整的消息，他能直接发。',
      '- 除非她已明显表现出好感，否则不要浪漫、不要撩、不要越界，能量跟她对齐。',
      '- 她热度低时，回复要短、低压，别硬推。',
      '- 每条回复不超过 30 个词，轻松自然。',
    ].join('\n');
    const raw = await callLLM({ prompt, temperature, timeoutMs: 60000 });
    const parsed = parseJSON(raw);
    if (!parsed || !Array.isArray(parsed.replies)) throw new Error('模型返回的格式不对：' + String(raw || '').slice(0, 120));

    if (parsed.interest) {
      const real = await getState(chat);
      real.interestHistory = (real.interestHistory || []).concat({ ts: Date.now(), interest: parsed.interest }).slice(-30);
      if (parsed.stage) real.stage = parsed.stage;
      saveStatesSoon();
    }
    return parsed;
  };

  handlers['wm:review'] = async ({ chat, messages }) => {
    if (!chat) throw new Error('请先设置目标');
    const convo = convoText(await history(chat, messages, 60));
    const prompt = [
      '你是陪聊教练。下面是用户和对方最近一段对话。做一次复盘，帮他下次聊得更好。',
      '',
      '---对话---',
      convo || '（无）',
      '---结束---',
      '',
      '只输出 JSON，不要 markdown，严格包含这些键（值都用中文写）：',
      '{',
      '  "good": "这一局他做得好的地方（1-2 条）",',
      '  "bad": "这一局做得不好、或可能踩雷的地方（1-2 条，诚实）",',
      '  "next": "下一局具体怎么做（一句具体动作）"',
      '}',
    ].join('\n');
    const raw = await callLLM({ prompt, timeoutMs: 60000 });
    const parsed = parseJSON(raw);
    if (!parsed) throw new Error('模型返回的格式不对：' + String(raw || '').slice(0, 120));
    return parsed;
  };

  return handlers;
}

module.exports = { createWingman, WINGMAN_DEFAULTS, WINGMAN_PAGE_KEYS };
