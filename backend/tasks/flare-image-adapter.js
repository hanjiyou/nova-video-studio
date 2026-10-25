'use strict';
const { containsCredential } = require('../connections/redaction');
const { buildRequestInit } = require('../plugin-runtime/request-body');
const { POLICY, validParameters } = require('./image-policy');
const MODEL = POLICY.model;
const BASE_URL = POLICY.baseUrl;
const VERSION = '1.1.0';
function failure(code, fields = {}) { return Object.assign(new Error(code), { code, ...fields }); }
function validateSnapshot(snapshot, auth) {
    if (snapshot.model !== MODEL || typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim() || !Array.isArray(snapshot.inputAssets) ||
        !validParameters(snapshot.parameters || {})) throw failure('INPUT_INVALID');
    if (auth.baseUrl !== BASE_URL || auth.provider !== POLICY.provider || auth.protocol !== POLICY.protocol) throw failure('CAPABILITY_UNVERIFIED');
    if (snapshot.adapterVersion === '1.0.0' && (snapshot.mode !== 'image.text' || snapshot.inputAssets.length || Object.keys(snapshot.parameters || {}).length)) throw failure('INPUT_INVALID');
}
/** The host alone resolves a single original PNG/JPEG; FormData owns its boundary. */
function buildReferenceSubmit(snapshot, auth, getAsset) {
    validateSnapshot(snapshot, auth);
    if (snapshot.mode !== 'image.reference' || snapshot.inputAssets.length !== 1) throw failure('INPUT_INVALID');
    const input = snapshot.inputAssets[0], asset = getAsset?.(input.assetId);
    if (input.position !== 0 || input.role !== 'reference' || asset?.kind !== 'image' || !['image/png','image/jpeg'].includes(asset.mimeType)) throw failure('INPUT_INVALID');
    return { method: 'POST', url: auth.baseUrl + '/images/edits', encoding: 'multipart',
        parts: [{ kind: 'field', name: 'model', value: MODEL }, { kind: 'field', name: 'prompt', value: snapshot.prompt },
            { kind: 'field', name: 'n', value: '1' }, ...['size','quality'].filter(name => snapshot.parameters?.[name] !== undefined).map(name => ({ kind: 'field', name, value: snapshot.parameters[name] })),
            { kind: 'file', name: 'image', assetId: input.assetId, fileName: 'reference.' + (asset.mimeType === 'image/png' ? 'png' : 'jpg'), mimeType: asset.mimeType }],
        auth: { connectionVersionId: auth.connectionVersionId } };
}
function buildSubmit(snapshot, auth, getAsset) {
    if (snapshot.mode === 'image.reference') return buildReferenceSubmit(snapshot, auth, getAsset);
    validateSnapshot(snapshot, auth);
    if (snapshot.mode !== 'image.text' || snapshot.inputAssets.length) throw failure('INPUT_INVALID');
    // With automatic controls this stays byte-for-byte the proven minimum JSON shape.
    return { method: 'POST', url: auth.baseUrl + '/images/generations', encoding: 'json',
        json: { model: MODEL, prompt: snapshot.prompt, n: 1, ...snapshot.parameters }, auth: { connectionVersionId: auth.connectionVersionId } };
}
function parseSubmit(payload, auth) {
    if (containsCredential(JSON.stringify(payload), auth.apiKey)) throw failure('RESPONSE_CREDENTIAL_REDACTED', { credentialRedacted: true });
    if (!Array.isArray(payload?.data) || !payload.data.length || payload.data.length > 32) throw failure('SUBMISSION_UNKNOWN',{parseOutcome:Array.isArray(payload?.data)&&!payload.data.length?'no_result':'unexpected_schema'});
    const resultSources = payload.data.map(item => {
        if (typeof item?.b64_json === 'string' && item.b64_json.length) {
            const compact = item.b64_json;
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) throw failure('SUBMISSION_UNKNOWN',{parseOutcome:'unexpected_schema'});
            const bytes = Buffer.from(compact, 'base64');
            if (!bytes.length) throw failure('SUBMISSION_UNKNOWN',{parseOutcome:'unexpected_schema'});
            const mimeType = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
                bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
            if (!mimeType) throw failure('SUBMISSION_UNKNOWN',{parseOutcome:'unexpected_schema'});
            return { kind: 'inline', bytes, mimeType, mediaKind: 'image' };
        }
        if (typeof item?.url === 'string' && item.url.trim()) {
            let url;
            try { url = new URL(item.url); } catch { throw failure('SUBMISSION_UNKNOWN',{parseOutcome:'unexpected_schema'}); }
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw failure('SUBMISSION_UNKNOWN',{parseOutcome:'unexpected_schema'});
            return { kind: 'url', url: url.toString(), authScope: 'none', mediaKind: 'image' };
        }
        throw failure('SUBMISSION_UNKNOWN',{parseOutcome:'unexpected_schema'});
    });
    return { resultSources };
}
function createFlareImageAdapter({ validateCapability, readAsset, getAsset, version = VERSION }) {
    if (![VERSION, '1.0.0'].includes(version)) throw failure('ADAPTER_UNAVAILABLE');
    return { id: 'opensosen-flare-image', version,
        preflight(_task, snapshot, auth) {
            const request = buildSubmit(snapshot, auth, getAsset);
            validateCapability(snapshot, auth);
            buildRequestInit(request, { ...auth, inputAssets: snapshot.inputAssets }, readAsset);
        },
        async submit(_task, snapshot, auth) {
            auth.checkpoint?.(); auth.phase?.(snapshot.mode === 'image.reference' ? 'reference_upload' : 'submitting');
            const request = buildSubmit(snapshot, auth, getAsset);
            validateCapability(snapshot, auth);
            const controller = new AbortController(), abort = () => controller.abort();
            auth.signal?.addEventListener('abort', abort, { once: true });
            if (auth.signal?.aborted) controller.abort();
            const timer = setTimeout(abort, Math.min(30 * 60 * 1000, auth.remainingMs?.() ?? 30 * 60 * 1000));
            try {
                const init=buildRequestInit(request, { ...auth, inputAssets: snapshot.inputAssets }, readAsset);
                auth.checkpoint?.();
                auth.phase?.('submitting');
                auth.diagnostic?.('request_started',{operation:'submit'});
                const response = await fetch(request.url, { ...init, signal: controller.signal });
                auth.phase?.('receiving'); auth.diagnostic?.('response_headers',{httpStatus:response.status});
                const text = await response.text(); // Includes the complete body in the request deadline.
                auth.checkpoint?.(); auth.diagnostic?.('body_received',{byteLength:Buffer.byteLength(text)}); auth.phase?.('parsing');
                let payload;
                try { payload = JSON.parse(text); } catch { throw failure('SUBMISSION_UNKNOWN', { parseOutcome:'invalid_json', httpStatus: response.status }); }
                if (containsCredential(text, auth.apiKey) || containsCredential(JSON.stringify(payload), auth.apiKey)) throw failure('RESPONSE_CREDENTIAL_REDACTED', { credentialRedacted: true });
                if (!response.ok) throw failure('SUBMISSION_UNKNOWN', { httpStatus: response.status, transmission: 'response_received',
                    definiteRejection: response.status >= 400 && response.status < 500 && Boolean(payload?.error || payload?.message) });
                const parsed = parseSubmit(payload, auth); auth.checkpoint?.(); return parsed;
            } finally { clearTimeout(timer); auth.signal?.removeEventListener('abort', abort); }
        },
        poll() { throw failure('ADAPTER_UNAVAILABLE'); },
    };
}
module.exports = { createFlareImageAdapter, buildSubmit, buildReferenceSubmit, parseSubmit, MODEL, VERSION };
