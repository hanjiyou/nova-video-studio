'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const SESSION_HEADER = 'x-nova-session';
function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
function createNetworkPolicy({ directFetch, proxyFetch, backendOrigin, mode = 'direct', fallbackDelayMs = 200, maxFallbackWaitMs = 2000, timeoutMs = 30 * 60 * 1000 }) {
  if (!['direct', 'system', 'direct-first'].includes(mode)) throw new Error('Invalid NOVA_NETWORK_MODE');
  const controllers = new Set();
  async function policyFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const readOnly = method === 'GET' || method === 'HEAD';
    const internal = url.origin === backendOrigin;
    const headers = new Headers(init.headers || input?.headers || {});
    if (!internal) headers.delete(SESSION_HEADER);
    const controller = new AbortController();
    const signal = init.signal || input?.signal;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    controllers.add(controller);
    const options = { ...init, headers, signal: combined, redirect: internal || !readOnly ? 'manual' : (init.redirect || 'follow') };
    const selected = !internal && mode === 'system' ? proxyFetch : directFetch;
    try {
      let response;
      let directError;
      try { response = await selected(input, options); } catch (error) { directError = error; }
      if (mode === 'direct-first' && readOnly && !internal && !combined.aborted) {
        const retryable = directError || (response && ([429, 502, 503, 504].includes(response.status) || (response.status >= 400 && /text\/html/i.test(response.headers.get('content-type') || ''))));
        if (retryable) {
          const retryAfter = retryAfterMs(response?.headers.get('retry-after'));
          // Never shorten a valid server wait and retry earlier than requested.
          if (retryAfter !== null && retryAfter > maxFallbackWaitMs) return response;
          await response?.body?.cancel();
          await delay(Math.min(maxFallbackWaitMs, retryAfter ?? fallbackDelayMs), undefined, { signal: combined });
          return await proxyFetch(input, options); // At most two transport attempts, GET/HEAD only.
        }
      }
      if (directError) throw directError;
      return response;
    } catch (cause) {
      if (!readOnly) {
        const error = new Error('创建请求传输中断，提交结果需要核对；不会自动重新提交。', { cause });
        error.code = 'SUBMISSION_UNKNOWN';
        error.transmission = 'may_have_reached_upstream';
        throw error;
      }
      throw cause;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  return { fetch: policyFetch, abortPending: () => { for (const controller of controllers) controller.abort(); } };
}
function installNetworkPolicy(target, options) {
  const original = target.fetch;
  const policy = createNetworkPolicy({ directFetch: original, ...options });
  target.fetch = policy.fetch;
  return { ...policy, dispose() { policy.abortPending(); if (target.fetch === policy.fetch) target.fetch = original; } };
}
module.exports = { createNetworkPolicy, installNetworkPolicy, retryAfterMs };
