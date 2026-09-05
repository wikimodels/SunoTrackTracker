// content_main.js — runs in MAIN world, has access to window.Clerk
(function () {
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== 'SUNO_GET_TOKEN_REQ') return;

    let token = null;
    let error = null;
    try {
      // Попытка 1: Clerk SDK
      if (window.Clerk && window.Clerk.session && typeof window.Clerk.session.getToken === 'function') {
        token = await window.Clerk.session.getToken();
      } else if (window.Clerk && typeof window.Clerk.getToken === 'function') {
        token = await window.Clerk.getToken();
      }
      // Попытка 2: localStorage brute force (на случай если Clerk недоступен)
      if (!token) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.includes('clerk') && k.includes('token')) {
            try {
              const v = JSON.parse(localStorage.getItem(k) || '');
              if (typeof v === 'string' && v.startsWith('eyJ')) token = v;
            } catch (_) {}
          }
        }
      }
    } catch (e) {
      error = String(e && e.message || e);
    }

    window.postMessage({
      type: 'SUNO_GET_TOKEN_RESP',
      nonce: data.nonce,
      token: token,
      error: error
    }, '*');
  });
})();
