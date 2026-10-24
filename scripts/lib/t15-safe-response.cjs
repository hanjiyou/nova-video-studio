'use strict';
const { containsCredential } = require('../../backend/connections/redaction');
function secretEcho(value, credential) {
    if (!credential || typeof value !== 'string') return false;
    const variants = [credential, Buffer.from(credential).toString('base64'), Buffer.from(credential).toString('hex')];
    return variants.some(secret => containsCredential(value, secret));
}
function safeText(value, credential, limit) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value);
    if (secretEcho(text, credential)) return '[credential redacted]';
    return text.replace(/https?:\/\/\S+/gi, '[url omitted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[credential redacted]').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, limit);
}
async function safeResponseError(response, credential, { maxBytes = 65536, timeoutMs = 3000 } = {}) {
    const reader = response.clone().body?.getReader();
    let truncated = false, timedOut = false, raw = '', timer;
    const consume = async () => {
        if (!reader) return;
        const chunks = []; let size = 0;
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > maxBytes) { truncated = true; void reader.cancel().catch(() => {}); break; }
            chunks.push(Buffer.from(value));
        }
        raw = Buffer.concat(chunks).toString('utf8');
    };
    try { await Promise.race([consume(), new Promise(resolve => { timer = setTimeout(() => { timedOut = true; void reader?.cancel().catch(() => {}); resolve(); }, timeoutMs); })]); } catch { raw = ''; }
    finally { clearTimeout(timer); }
    let payload; if (!truncated && !timedOut) { try { payload = JSON.parse(raw); } catch { /* Arbitrary HTML/raw bodies are not diagnostic fields. */ } }
    const error = payload?.error, requestId = payload?.request_id || payload?.requestId ||
        ['x-request-id', 'request-id', 'x-oneapi-request-id', 'x-new-api-request-id', 'x-trace-id', 'trace-id'].map(name => response.headers.get(name)).find(Boolean);
    return { httpStatus: response.status, code: safeText(error?.code ?? payload?.code ?? error?.type, credential, 96),
        message: safeText(error?.message ?? payload?.message ?? payload?.msg ?? (typeof error === 'string' ? error : undefined), credential, 512) || (truncated ? '[error body exceeded limit]' : timedOut ? '[error body read timed out]' : '[no structured error message]'),
        requestId: safeText(requestId, credential, 160), bodyTruncated: truncated, bodyTimedOut: timedOut, credentialEchoSuppressed: secretEcho(raw, credential) };
}
module.exports = { safeResponseError, safeText };
