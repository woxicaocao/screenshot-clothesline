'use strict';
(() => {
  const api = window.rack;
  const input = document.getElementById('connectionCode');
  const copy = document.getElementById('copyCode');
  const message = document.getElementById('message');
  function fail(error) { message.textContent = error?.message || '连接暂时未就绪，请退出程序后重试。'; message.classList.add('error'); }
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    try { await api.copyBrowserConnection(); message.classList.remove('error'); message.textContent = '已复制。打开浏览器扩展，粘贴连接码并连接。'; }
    catch (error) { fail(error); }
    finally { copy.disabled = false; }
  });
  document.getElementById('closeWindow').addEventListener('click', () => api.closeBrowserConnection().catch(fail));
  api.getBrowserConnection().then(result => {
    if (!result?.code) throw new Error(result?.error || '本地连接未能启动，请退出程序后重试。');
    input.value = result.code; copy.disabled = false;
  }).catch(error => { input.value = '本地连接暂时不可用'; fail(error); });
})();
