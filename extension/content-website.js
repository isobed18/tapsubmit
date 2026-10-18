// Secure bridge between TapSubmit website (tapsubmit.com) and the Chrome/Edge extension.
// Verifies window.location.origin and uses a per-page random nonce to prevent spoofing.

(function () {
  const ALLOWED = new Set([
    'https://tapsubmit.com',
    'https://www.tapsubmit.com'
  ]);
  const origin = window.location.origin;
  if (!ALLOWED.has(origin) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return;

  const bridgeNonce = crypto.randomUUID();
  document.documentElement.setAttribute('data-tapsubmit-extension', '1.0.0');
  document.documentElement.setAttribute('data-tapsubmit-nonce', bridgeNonce);

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.channel !== 'TAPSUBMIT_PAGE_TO_EXT' || data.nonce !== bridgeNonce) return;

    try {
      const response = await chrome.runtime.sendMessage(data.payload);
      window.postMessage({
        channel: 'TAPSUBMIT_EXT_TO_PAGE',
        nonce: bridgeNonce,
        requestId: data.requestId || null,
        response
      }, origin);
    } catch (err) {
      window.postMessage({
        channel: 'TAPSUBMIT_EXT_TO_PAGE',
        nonce: bridgeNonce,
        requestId: data.requestId || null,
        response: { ok: false, error: err?.message || 'Extension communication error' }
      }, origin);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'EXTENSION_SOURCE_BATCH' || msg?.type === 'EXTENSION_APPLICATION_EVENT') {
      window.postMessage({
        channel: 'TAPSUBMIT_EXT_STREAM',
        nonce: bridgeNonce,
        message: msg
      }, origin);
    }
  });
})();
