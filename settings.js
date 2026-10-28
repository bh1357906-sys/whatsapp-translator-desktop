const api = window.settingsApi;

(async () => {
  const s = await api.get();
  document.getElementById('engine').value = s.engine || 'deepseek';
  document.getElementById('apiKey').value = s.apiKey || '';
  document.getElementById('myLang').value = s.myLang || 'Simplified Chinese';
  document.getElementById('theirLang').value = s.theirLang || 'English';
})();

document.getElementById('save').addEventListener('click', async () => {
  await api.set({
    engine: document.getElementById('engine').value,
    apiKey: document.getElementById('apiKey').value.trim(),
    myLang: document.getElementById('myLang').value,
    theirLang: document.getElementById('theirLang').value,
  });
  const st = document.getElementById('status');
  st.textContent = '已保存 ✓';
  setTimeout(() => window.close(), 600);
});
