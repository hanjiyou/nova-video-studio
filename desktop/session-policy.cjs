'use strict';
const { SESSION_HEADER } = require('../backend/desktop-session');
function isOwnOrigin(url, origin) {
  try { const parsed = new URL(url); return !parsed.username && !parsed.password && parsed.origin === origin; } catch { return false; }
}
function isBackendTarget(url, origin) {
  try { const parsed = new URL(url); if (parsed.protocol === 'ws:') parsed.protocol = 'http:'; return !parsed.username && !parsed.password && parsed.origin === origin; } catch { return false; }
}
function createSessionPolicy({ origin, token, getWebContents }) {
  function trustedFrame(details) {
    const contents = getWebContents();
    if (!contents || contents.isDestroyed() || details.webContentsId !== contents.id) return false;
    const frame = details.frame;
    return Boolean(frame && frame === contents.mainFrame && isOwnOrigin(frame.url, origin));
  }
  return {
    beforeRequest(details) {
      if (details.resourceType === 'subFrame') return { cancel: true };
      if (details.resourceType === 'mainFrame' && !isOwnOrigin(details.url, origin)) return { cancel: true };
      return { cancel: false };
    },
    beforeSendHeaders(details) {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === SESSION_HEADER) delete headers[key];
      // Desktop PWA workers are disabled, rather than granting a token to background/no-frame initiators.
      if (Object.entries(headers).some(([key, value]) => key.toLowerCase() === 'service-worker' && value === 'script')) return { cancel: true };
      if (isBackendTarget(details.url, origin) && trustedFrame(details)) headers[SESSION_HEADER] = token;
      return { requestHeaders: headers };
    },
    headersReceived(details) {
      const headers = { ...details.responseHeaders };
      if (details.resourceType === 'mainFrame' && isOwnOrigin(details.url, origin)) {
        // Chromium attributes dedicated-worker fetches to their owning frame. Disable workers
        // at the document boundary so they can never borrow the main frame's authority.
        const key = Object.keys(headers).find(name => name.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
        headers[key] = [...(headers[key] || []), "worker-src 'none'; frame-src 'none'"];
      }
      return { responseHeaders: headers };
    },
    isTrustedSender(event) {
      const contents = getWebContents();
      return Boolean(contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && isOwnOrigin(event.senderFrame.url, origin));
    },
    attach(session) {
      session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback(this.beforeRequest(details)));
      session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => callback(this.beforeSendHeaders(details)));
      session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => callback(this.headersReceived(details)));
      return () => { session.webRequest.onBeforeRequest(null); session.webRequest.onBeforeSendHeaders(null); session.webRequest.onHeadersReceived(null); };
    },
  };
}
function constrainNavigation(contents, origin) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!isOwnOrigin(event.url || url, origin)) event.preventDefault(); });
  contents.on('will-frame-navigate', event => { if (!event.isMainFrame || !isOwnOrigin(event.url, origin)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!isOwnOrigin(event.url || url, origin)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
}
module.exports = { createSessionPolicy, constrainNavigation, isOwnOrigin, isBackendTarget };
