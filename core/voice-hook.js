// 语音消息抓取：这段代码要运行在网页“主环境”里（桌面版用 webFrame 注入，插件用 MAIN world 内容脚本）。
// WhatsApp / Telegram 播放语音时会创建一个 <audio>（src 是 blob:），我们在 play() 时把这段音频读出来，
// 通过 DOM 事件交给翻译脚本。只读本地已解密好的音频，不发任何网络请求。
'use strict';

function voiceHookMain() {
  if (window.__trxVoiceHook) return;
  window.__trxVoiceHook = true;
  const MAX = 20 * 1024 * 1024;
  const recent = new Map(); // src → 已读出的数据，避免重复读取
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
      while (recent.size > 20) recent.delete(recent.keys().next().value);
      emit(payload);
    } catch (e) {
      emit({ src, error: '读取语音失败：' + (e && e.message) });
    }
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
