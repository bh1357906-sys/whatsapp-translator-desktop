// 插件设置页：代替桌面版的 settings-preload.js
'use strict';
(function () {
  function call(ch, arg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ __trx: 1, ch, arg: arg === undefined ? null : arg }, (res) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(le.message));
        if (!res || !res.ok) return reject(new Error((res && res.error) || '后台没有响应'));
        resolve(res.result);
      });
    });
  }

  const BUILTIN = ['https://api.deepseek.com', 'https://api.openai.com', 'https://generativelanguage.googleapis.com'];

  // 自定义接口地址需要额外授权才能访问（必须在点击里同步发起）
  function ensurePermission(s) {
    const base = (s && s.apiBase) || '';
    if (!base) return Promise.resolve(true);
    let origin;
    try {
      origin = new URL(base).origin;
    } catch (_) {
      return Promise.reject(new Error('接口地址格式不对'));
    }
    if (BUILTIN.includes(origin)) return Promise.resolve(true);
    return chrome.permissions.request({ origins: [origin + '/*'] }).then((ok) => {
      if (!ok) throw new Error('没有授权访问 ' + origin + '，无法使用这个接口地址');
      return true;
    });
  }

  window.settingsApi = {
    get: () => call('st:get'),
    set: (s) => ensurePermission(s).then(() => call('st:set', s)),
    test: (s) => ensurePermission(s).then(() => call('st:test', s)),
    checkUpdate: () => Promise.resolve(false),
  };
})();
