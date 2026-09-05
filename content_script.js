// content_script.js — ISOLATED world, bridge between MAIN and background
(function () {
  // Проксируем запрос токена из background -> MAIN -> обратно
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'GET_TOKEN_VIA_CLERK') {
      const nonce = 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const handler = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.type !== 'SUNO_GET_TOKEN_RESP' || d.nonce !== nonce) return;
        window.removeEventListener('message', handler);
        sendResponse({ token: d.token, error: d.error });
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'SUNO_GET_TOKEN_REQ', nonce }, '*');
      // таймаут 5с
      setTimeout(() => {
        window.removeEventListener('message', handler);
        sendResponse({ token: null, error: 'timeout' });
      }, 5000);
      return true; // async
    }
  });
})();
