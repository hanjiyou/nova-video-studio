'use strict';
const { timingSafeEqual } = require('node:crypto');
const SESSION_HEADER = 'x-nova-session';
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || '').toLowerCase());
function createDesktopBoundary({ token, origin }) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Desktop session requires a random 256-bit token');
  const allowed = new URL(origin);
  if (allowed.protocol !== 'http:' || allowed.hostname !== '127.0.0.1' || allowed.origin !== origin) throw new Error('Invalid desktop backend origin');
  const expected = Buffer.from(token);
  let active = true;
  return {
    origin,
    authorize(req, { sensitive = true, websocket = false } = {}) {
      const denied = { ok: false, status: 403, code: 'DESKTOP_SESSION_REQUIRED' };
      if (!active || !loopback(req.socket?.remoteAddress) || req.headers.host !== allowed.host) return denied;
      const source = req.headers.origin;
      if ((source !== undefined && source !== origin) || (websocket && source !== origin)) return denied;
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return denied;
      if (sensitive || websocket) {
        const value = req.headers[SESSION_HEADER];
        if (typeof value !== 'string' || value.length !== 64) return denied;
        const actual = Buffer.from(value);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return denied;
      }
      return { ok: true };
    },
    revoke() { active = false; expected.fill(0); },
  };
}
let desktopBoundary = null;
function configureDesktopSession(config) {
  if (desktopBoundary) throw new Error('Desktop session already configured');
  desktopBoundary = createDesktopBoundary(config);
}
module.exports = {
  SESSION_HEADER, createDesktopBoundary, configureDesktopSession,
  isDesktopMode: () => desktopBoundary !== null,
  authorizeDesktopRequest: (req, options) => desktopBoundary ? desktopBoundary.authorize(req, options) : { ok: true },
  revokeDesktopSession: () => desktopBoundary?.revoke(),
};
