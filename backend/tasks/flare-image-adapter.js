'use strict';
const { containsCredential } = require('../connections/redaction');
const { buildRequestInit } = require('../plugin-runtime/request-body');
const MODEL = 'gpt-image-2.5-flare';
const BASE_URL = 'https://newapi.opensosen.com/v1';
const VERSION = '1.0.0';
function failure(code, fields = {}) { return Object.assign(new Error(code), { code, ...fields }); }
/** Candidate minimum text protocol from the historical client, not a verified upstream claim. */
function buildReferenceSubmit(snapshot) {
    if (snapshot.model !== MODEL || typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim() || !Array.isArray(snapshot.inputAssets) || !snapshot.inputAssets.length) throw failure('INPUT_INVALID');
    throw failure('CAPABILITY_UNVERIFIED'); // Independent boundary; no guessed edit endpoint or fields.
}
function buildSubmit(snapshot, auth) {
    if (snapshot.mode === 'image.reference') return buildReferenceSubmit(snapshot, auth);
    if (snapshot.model !== MODEL || typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim() || !Array.isArray(snapshot.inputAssets)) throw failure('INPUT_INVALID');
    if (snapshot.mode !== 'image.text' || snapshot.inputAssets.length) throw failure('INPUT_INVALID');
    if (auth.baseUrl !== BASE_URL || Object.keys(snapshot.parameters || {}).length) throw failure('CAPABILITY_UNVERIFIED');
    // No size/quality/style/background, streaming, implicit model selection or retry parameters.
    return { method: 'POST', url: auth.baseUrl + '/images/generations', encoding: 'json',
        json: { model: MODEL, prompt: snapshot.prompt, n: 1 }, auth: { connectionVersionId: auth.connectionVersionId } };
}
function parseSubmit(payload, auth) {
    if (containsCredential(JSON.stringify(payload), auth.apiKey)) throw failure('RESPONSE_CREDENTIAL_REDACTED', { credentialRedacted: true });
    if (!Array.isArray(payload?.data) || !payload.data.length || payload.data.length > 32) throw failure('SUBMISSION_UNKNOWN');
    const resultSources = payload.data.map(item => {
        if (typeof item?.b64_json === 'string' && item.b64_json.length) {
            const compact = item.b64_json;
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) throw failure('SUBMISSION_UNKNOWN');
            const bytes = Buffer.from(compact, 'base64');
            if (!bytes.length) throw failure('SUBMISSION_UNKNOWN');
            const mimeType = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
                bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
            if (!mimeType) throw failure('SUBMISSION_UNKNOWN');
            return { kind: 'inline', bytes, mimeType, mediaKind: 'image' };
        }
        if (typeof item?.url === 'string' && item.url.trim()) {
            let url;
            try { url = new URL(item.url); } catch { throw failure('SUBMISSION_UNKNOWN'); }
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw failure('SUBMISSION_UNKNOWN');
            return { kind: 'url', url: url.toString(), authScope: 'none', mediaKind: 'image' };
        }
        throw failure('SUBMISSION_UNKNOWN');
    });
    return { resultSources };
}
function createFlareImageAdapter({ validateCapability }) {
    return { id: 'opensosen-flare-image', version: VERSION,
        preflight(_task, snapshot, auth) { buildSubmit(snapshot, auth); validateCapability(snapshot, auth); },
        async submit(_task, snapshot, auth) {
            const request = buildSubmit(snapshot, auth);
            validateCapability(snapshot, auth);
            const controller = new AbortController(), abort = () => controller.abort();
            auth.signal?.addEventListener('abort', abort, { once: true });
            if (auth.signal?.aborted) controller.abort();
            const timer = setTimeout(abort, 30 * 60 * 1000);
            try {
                const response = await fetch(request.url, { ...buildRequestInit(request, auth), signal: controller.signal });
                const text = await response.text(); // Includes the complete body in the request deadline.
                let payload;
                try { payload = JSON.parse(text); } catch { throw failure('SUBMISSION_UNKNOWN', { httpStatus: response.status }); }
                if (containsCredential(text, auth.apiKey) || containsCredential(JSON.stringify(payload), auth.apiKey)) throw failure('RESPONSE_CREDENTIAL_REDACTED', { credentialRedacted: true });
                if (!response.ok) throw failure('SUBMISSION_UNKNOWN', { httpStatus: response.status, transmission: 'response_received',
                    definiteRejection: response.status >= 400 && response.status < 500 && Boolean(payload?.error || payload?.message) });
                return parseSubmit(payload, auth);
            } finally { clearTimeout(timer); auth.signal?.removeEventListener('abort', abort); }
        },
        poll() { throw failure('ADAPTER_UNAVAILABLE'); },
    };
}
module.exports = { createFlareImageAdapter, buildSubmit, buildReferenceSubmit, parseSubmit, MODEL, VERSION };
