'use strict';
const { randomUUID } = require('node:crypto');
const OPENSOSEN_URL = 'https://newapi.opensosen.com/v1';
const PRESET_MODELS = Object.freeze(['gpt-image-2.5-flare', 'grok-imagine-video-6s', 'grok-imagine-video-1.5-6s']);
const EVIDENCE_VERSION = 'opensosen-evidence-v1';
function normalizeBaseUrl(value) {
    if (typeof value === 'string')
        value = value.trim();
    if (typeof value !== 'string' || value.length > 2048 || /[\s\p{Cc}\\]/u.test(value))
        throw invalid();
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw invalid();
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname))
        throw invalid();
    let pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:images\/(?:generations|edits)|videos|models)$/, '');
    if (!pathname)
        pathname = '/v1';
    return url.origin + pathname;
}
function invalid() { return Object.assign(new Error('请输入不含凭据、查询或片段的HTTP(S)服务基础地址。'), { code: 'CONNECTION_URL_INVALID', statusCode: 400, connectionError: true }); }
function seedCapabilities(db, provider, baseUrl) {
    const insert = db.prepare(`INSERT OR IGNORE INTO model_capabilities(id,provider,base_url,model,mode,protocol,parameters_json,evidence_level,evidence_version,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const model of PRESET_MODELS) {
        const modes = model === PRESET_MODELS[0] ? ['image.text', 'image.reference'] : ['video.text', 'video.single_reference', 'video.dual_reference'];
        for (const mode of modes) {
            const historical = provider === 'opensosen' && baseUrl === OPENSOSEN_URL && model === PRESET_MODELS[2] && mode !== 'video.text';
            const parameters = historical ? { seconds: 6, size: '1280x720', encoding: 'multipart', inputReferenceName: 'input_reference', referenceCount: mode === 'video.dual_reference' ? 2 : 1 } : {};
            const evidence = historical ? { sourceIds: mode === 'video.dual_reference' ? ['H02', 'H03', 'H06'] : ['H01'], applicationVerified: false, referenceSemantics: 'ordered_references' } : { sourceIds: [], applicationVerified: false };
            insert.run(randomUUID(), provider, baseUrl, model, mode, 'openai', JSON.stringify(parameters), historical ? 'historically_verified' : 'unverified', EVIDENCE_VERSION, JSON.stringify(evidence), new Date().toISOString());
        }
    }
}
function listCapabilities(db, provider, baseUrl) {
    return db.prepare('SELECT * FROM model_capabilities WHERE provider=? AND base_url=? ORDER BY model,mode').all(provider, baseUrl).map(row => ({ capabilityVersionId: row.id, provider: row.provider, baseUrl: row.base_url, model: row.model, mode: row.mode, protocol: row.protocol, parameters: JSON.parse(row.parameters_json), evidenceLevel: row.evidence_level, evidenceVersion: row.evidence_version, evidence: JSON.parse(row.evidence_json) }));
}
module.exports = { OPENSOSEN_URL, PRESET_MODELS, EVIDENCE_VERSION, normalizeBaseUrl, seedCapabilities, listCapabilities };
