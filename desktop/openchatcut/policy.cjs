'use strict';

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const NOVA_HEADER = 'x-nova-session';
const VIEWPORT_KEYS = ['visible', 'x', 'y', 'width', 'height'];

function loopbackOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || value !== url.origin) return null;
    return url.origin;
  } catch { return null; }
}

function editorPath(value) {
  if (value === undefined) return '/';
  return typeof value === 'string' && /^\/#\/editor\/[a-f0-9-]{36}$/i.test(value) ? value : null;
}

function sameOrigin(value, origin) {
  try { const url = new URL(value); return !url.username && !url.password && url.origin === origin; }
  catch { return false; }
}

function partitionName(directory) {
  return 'persist:nova-openchatcut-' + createHash('sha256').update(directory).digest('hex').slice(0, 24);
}

function publicResourceHostname(value) {
  const host = value.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(host) === 6) {
    const prefix = parseInt(host.split(':')[0] || '0', 16);
    // Global-unicast literals only. This excludes loopback, unspecified,
    // link-local, unique-local, multicast and all IPv4-mapped forms.
    return prefix >= 0x2000 && prefix <= 0x3fff && !host.startsWith('2001:db8:');
  }
  return host.includes('.') && !['localhost', 'local', 'internal'].some(suffix => host === suffix || host.endsWith('.' + suffix));
}

function validateViewport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== VIEWPORT_KEYS.length
    || Object.keys(input).some(key => !VIEWPORT_KEYS.includes(key))
    || typeof input.visible !== 'boolean'
    || ['x', 'y', 'width', 'height'].some(key => !Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > 100000)) return null;
  if (input.visible && (!input.width || !input.height)) return null;
  return { visible: input.visible, x: input.x, y: input.y, width: input.width, height: input.height };
}

function viewportBounds(input, content, zoom = 1, sidebarCss = 202) {
  const factor = Number.isFinite(zoom) && zoom >= 0.25 && zoom <= 5 ? zoom : 1;
  const width = Math.max(0, Math.floor(content.width)), height = Math.max(0, Math.floor(content.height));
  const sidebar = Math.min(width, Math.ceil(sidebarCss * factor));
  const x = Math.min(width, Math.max(sidebar, Math.ceil(input.x * factor)));
  const y = Math.min(height, Math.ceil(input.y * factor));
  const right = Math.min(width, Math.floor((input.x + input.width) * factor));
  const bottom = Math.min(height, Math.floor((input.y + input.height) * factor));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function createEditorSessionPolicy(origin) {
  if (!loopbackOrigin(origin)) throw new Error('EDITOR_INVALID_ORIGIN');
  function permittedResource(url, resourceType) {
    if (sameOrigin(url, origin)) return true;
    if (resourceType === 'mainFrame') return false;
    if (url === 'about:blank' || url === 'about:srcdoc') return true;
    if (typeof url === 'string' && url.startsWith('blob:' + origin + '/')) return true;
    if (typeof url === 'string' && url.startsWith('data:') && resourceType !== 'subFrame') return true;
    if (resourceType === 'subFrame') return false;
    try {
      const parsed = new URL(url);
      // The original editor can load public stock media and model assets. HTTP,
      // local files and other loopback services remain inaccessible to this view.
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
      return publicResourceHostname(parsed.hostname);
    } catch { return false; }
  }
  return {
    beforeRequest(details) { return { cancel: !permittedResource(details.url, details.resourceType) }; },
    beforeSendHeaders(details) {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === NOVA_HEADER) delete headers[key];
      return { requestHeaders: headers };
    },
    attach(session) {
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback(this.beforeRequest(details)));
      session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => callback(this.beforeSendHeaders(details)));
      return () => {
        session.webRequest.onBeforeRequest(null);
        session.webRequest.onBeforeSendHeaders(null);
        session.setPermissionRequestHandler(null);
        session.setPermissionCheckHandler(null);
      };
    },
    constrain(contents) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const main = (event, url) => { if (!sameOrigin(event.url || url, origin)) event.preventDefault(); };
      const frame = event => { if (event.isMainFrame && !sameOrigin(event.url, origin)) event.preventDefault(); };
      const webview = event => event.preventDefault();
      contents.on('will-navigate', main);
      contents.on('will-redirect', main);
      contents.on('will-frame-navigate', frame);
      contents.on('will-attach-webview', webview);
      return () => {
        contents.removeListener('will-navigate', main);
        contents.removeListener('will-redirect', main);
        contents.removeListener('will-frame-navigate', frame);
        contents.removeListener('will-attach-webview', webview);
      };
    },
  };
}

module.exports = { loopbackOrigin, editorPath, sameOrigin, partitionName, validateViewport, viewportBounds, publicResourceHostname, createEditorSessionPolicy };
