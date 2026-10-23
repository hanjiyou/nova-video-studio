'use strict';
const { UUID } = require('../storage/store');
function invalid() { return Object.assign(new Error('受管请求描述无效。'), { code: 'INPUT_INVALID' }); }
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
}
/** Only the host resolves asset IDs. Drivers never supply paths or multipart boundaries. */
function buildRequestInit(request, context, readAsset) {
    const headers = { ...(request.headers || {}) };
    if (request.auth !== undefined) {
        exact(request.auth, ['connectionVersionId']);
        if (!context.connectionVersionId || request.auth.connectionVersionId !== context.connectionVersionId ||
            Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) throw invalid();
        headers.Authorization = 'Bearer ' + context.apiKey;
    }
    const init = { method: request.method || 'POST', headers, redirect: 'manual' };
    if (request.encoding === 'multipart') {
        if (request.body !== undefined || request.json !== undefined || typeof readAsset !== 'function' ||
            !Array.isArray(request.parts) || !request.parts.length || request.parts.length > 64 ||
            Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) throw invalid();
        const form = new FormData();
        for (const part of request.parts) {
            if (part.kind === 'field') {
                exact(part, ['kind', 'name', 'value']);
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part.name) || typeof part.value !== 'string') throw invalid();
                form.append(part.name, part.value);
            } else if (part.kind === 'file') {
                exact(part, ['kind', 'name', 'assetId', 'fileName', 'mimeType']);
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part.name) || !UUID.test(part.assetId) ||
                    typeof part.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part.fileName) ||
                    !['image/png', 'image/jpeg'].includes(part.mimeType)) throw invalid();
                if (!context.inputAssets?.some(input => input.assetId === part.assetId)) throw invalid();
                const { bytes, asset } = readAsset(part.assetId);
                if (!Buffer.isBuffer(bytes) || !bytes.length || asset.kind !== 'image' || asset.mimeType !== part.mimeType) throw invalid();
                const signature = part.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
                if (!signature) throw invalid();
                form.append(part.name, new Blob([bytes], { type: part.mimeType }), part.fileName);
            } else throw invalid();
        }
        init.body = form;
    } else {
        if (request.parts !== undefined || (request.encoding !== undefined && request.encoding !== 'json')) throw invalid();
        const body = request.json === undefined ? request.body : request.json;
        if (body !== undefined) {
            init.body = typeof body === 'string' ? body : JSON.stringify(body);
            if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
        }
    }
    return init;
}
module.exports = { buildRequestInit };
