// 语音消息抓取：这段代码要运行在网页“主环境”里（桌面版用 webFrame 注入，插件用 MAIN world 内容脚本）。
// WhatsApp / Telegram 播放语音时会创建一个 <audio>（src 是 blob:），我们在 play() 时把这段音频读出来，
// 通过 DOM 事件交给翻译脚本。只读本地已解密好的音频，不发任何网络请求。
'use strict';

function voiceHookMain() {
  if (window.__trxVoiceHook) return;
  window.__trxVoiceHook = true;
  const MAX = 20 * 1024 * 1024;
  const MAX_IMG = 12 * 1024 * 1024;
  const RECENT_BYTES = 60 * 1024 * 1024; // 最多缓存这么多字节的音频，再多就丢最旧的
  const recent = new Map(); // src → 已读出的数据，避免重复读取
  let recentBytes = 0;
  const root = () => document.documentElement;

  function toB64(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function emit(payload) {
    document.dispatchEvent(new CustomEvent('trx-voice-data', { detail: JSON.stringify(payload) }));
  }
  async function capture(src) {
    if (recent.has(src)) return emit(recent.get(src));
    try {
      const r = await fetch(src);
      const blob = await r.blob();
      if (blob.size > MAX) return emit({ src, error: '语音太长' });
      const payload = { src, mime: blob.type || '', size: blob.size, b64: toB64(await blob.arrayBuffer()) };
      recent.set(src, payload);
      recentBytes += blob.size;
      while (recent.size > 20 || (recentBytes > RECENT_BYTES && recent.size > 1)) {
        const k = recent.keys().next().value;
        recentBytes -= recent.get(k).size || 0;
        recent.delete(k);
      }
      emit(payload);
    } catch (e) {
      emit({ src, error: '读取语音失败：' + (e && e.message) });
    }
  }

  // 图片：翻译脚本发 trx-capture-image {id, src}，这里把图片读出来回传（只读页面里已有的图，不发别的请求）
  document.addEventListener('trx-capture-image', async (e) => {
    let req = null;
    try {
      req = JSON.parse(e.detail);
    } catch (_) {}
    if (!req || !req.id || !req.src) return;
    const reply = (p) => document.dispatchEvent(new CustomEvent('trx-image-data', { detail: JSON.stringify({ id: req.id, ...p }) }));
    try {
      if (!/^(blob:|data:|https:)/.test(req.src)) throw new Error('unsupported src');
      const r = await fetch(req.src);
      const blob = await r.blob();
      if (blob.size > MAX_IMG) return reply({ error: '图片太大' });
      if (blob.size < 100) return reply({ error: '图片还没加载完' });
      reply({ src: req.src, mime: blob.type || '', size: blob.size, b64: toB64(await blob.arrayBuffer()) });
    } catch (err) {
      reply({ error: '读取图片失败：' + (err && err.message) });
    }
  });

  // ---- 发语音条：把合成好的语音当“麦克风”喂给网页的录音功能 ----
  // 翻译脚本先发 trx-tts-audio {b64, mime} 并给 <html> 加 data-trx-tts，再点网页的录音键；
  // 网页调用 getUserMedia 时拿到的就是这段音频，播完后我们发 trx-tts-ended，翻译脚本再点“发送”。
  // 没有 data-trx-tts 时完全不干预，真正的麦克风照常工作。
  let ttsPending = null;
  document.addEventListener('trx-tts-audio', (e) => {
    try {
      ttsPending = JSON.parse(e.detail);
    } catch (_) {
      ttsPending = null;
    }
  });
  document.addEventListener('trx-tts-cancel', () => {
    ttsPending = null;
  });
  const md = navigator.mediaDevices;
  const origGUM = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;
  const tell = (name, payload) => document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload || {}) }));
  if (origGUM) {
    md.getUserMedia = function (constraints) {
      const p = ttsPending;
      if (!p || !p.b64 || !constraints || !constraints.audio || !root().hasAttribute('data-trx-tts')) return origGUM(constraints);
      ttsPending = null;
      tell('trx-tts-gum', {}); // 告诉翻译脚本：网页已经开始要麦克风了
      return (async () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        // 用 48k：Telegram 新版录音器自己也用 48k 的 AudioContext，采样率一致最稳
        let ctx;
        try {
          ctx = new AC({ sampleRate: 48000 });
        } catch (_) {
          ctx = new AC();
        }
        try {
          await ctx.resume();
        } catch (_) {}
        if (ctx.state !== 'running') throw new Error('audio-context-' + ctx.state);
        const bin = atob(p.b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const buf = await ctx.decodeAudioData(u.buffer);
        const dest = ctx.createMediaStreamDestination();
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        const lead = 0.5; // 录音刚开始的半秒留空，免得开头被吃掉
        const tail = 0.6;
        src.onended = () => {
          setTimeout(() => {
            tell('trx-tts-ended', { ok: true });
            setTimeout(() => {
              try {
                dest.stream.getTracks().forEach((t) => t.stop());
                ctx.close();
              } catch (_) {}
            }, 5000);
          }, tail * 1000);
        };
        src.start(ctx.currentTime + lead);
        tell('trx-tts-started', { duration: buf.duration + lead + tail });
        return dest.stream;
      })().catch((err) => {
        tell('trx-tts-ended', { error: String((err && err.message) || err) });
        throw err;
      });
    };
  }

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    let silent = false;
    try {
      if (this.tagName === 'AUDIO') {
        const src = this.currentSrc || this.src;
        // “转文字”按钮触发的播放：静音，读到音频后马上暂停
        silent = root().hasAttribute('data-trx-voice-silent');
        if (silent) this.muted = true;
        if (src && root().hasAttribute('data-trx-voice-on')) capture(src);
      }
    } catch (_) {}
    const p = origPlay.apply(this, arguments);
    if (silent) {
      const el = this;
      const stop = () => {
        try {
          el.pause();
          el.currentTime = 0;
        } catch (_) {}
        setTimeout(() => (el.muted = false), 300);
      };
      if (p && p.then) p.then(stop, stop);
      else stop();
    }
    return p;
  };
}

const HOOK_SOURCE = '(' + voiceHookMain.toString() + ')();';

module.exports = { HOOK_SOURCE, voiceHookMain };
