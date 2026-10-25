'use strict';
const { randomUUID } = require('node:crypto');
const multiReference = require('../tasks/multi-reference-policy');
const imagePolicy = require('../tasks/image-policy');
const OPENSOSEN_URL = 'https://newapi.opensosen.com/v1';
const PRESET_MODELS = Object.freeze(['gpt-image-2.5-flare', 'grok-imagine-video-6s', 'grok-imagine-video-1.5-6s']);
const EVIDENCE_VERSION = 'opensosen-evidence-v1';
const APPLICATION_EVIDENCE_VERSION = 'opensosen-application-evidence-2026-10-24-v1';
const TEXT_VIDEO_EVIDENCE_VERSION = 'opensosen-text-video-evidence-2026-10-24-v1';
const TEXT_VIDEO_CAPABILITY = Object.freeze({ model: PRESET_MODELS[2], mode: 'video.text',
    parameters: { seconds: 6, encoding: 'multipart', referenceCount: 0 }, sourceIds: ['T15-TEXT-NO-SIZE-20261024'],
    outputSha256: '251b0407a70d9abbc67c16077092cab5884599f863471383bde5b05e1abaca75' });
// Reviewed actual application runs. Add a new version for new evidence; never rewrite a saved row.
const APPLICATION_CAPABILITIES = Object.freeze([
    { model: PRESET_MODELS[0], mode: 'image.text', parameters: {}, sourceIds: ['T15-FLARE-MINIMUM-20261024'],
        outputSha256: '30cf2191fd880ecf786a6a1353874e248a8ad0a633b60a9d746d77c64f6c4c8f',
        submit: { method: 'POST', path: '/images/generations', encoding: 'json', fields: ['model', 'prompt', 'n'], n: 1 } },
    { model: PRESET_MODELS[2], mode: 'video.single_reference', parameters: { seconds: 6, size: '1280x720', encoding: 'multipart', inputReferenceName: 'input_reference', referenceCount: 1 },
        sourceIds: ['T15-REFERENCE-RETEST-SINGLE-20261024'], outputSha256: '3754d2991674d27b2653ad95de224906b424676f6ca6f2ed41400fa94a58d1cd' },
    { model: PRESET_MODELS[2], mode: 'video.dual_reference', parameters: { seconds: 6, size: '1280x720', encoding: 'multipart', inputReferenceName: 'input_reference', referenceCount: 2 },
        sourceIds: ['T15-REFERENCE-RETEST-DUAL-20261024'], outputSha256: '49d2730c7500623ab1e85cb973e87f4b2ba4b136fc605a384fe6a268bc91a025' },
]);
function evidenceRank(level) { return ({ application_verified: 3, historically_verified: 2, unverified: 1 })[level] || 0; }
function generationEvidenceVerified(capability) {
    if (capability.evidence_level === 'historically_verified') return true;
    if (capability.evidence_level !== 'application_verified') return false;
    try { const evidence = JSON.parse(capability.evidence_json); return evidence.applicationVerified === true && Array.isArray(evidence.sourceIds) && evidence.sourceIds.length > 0; }
    catch { return false; }
}
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
    if (provider === 'opensosen' && baseUrl === OPENSOSEN_URL) for (const capability of APPLICATION_CAPABILITIES) {
        const evidence = { sourceIds: capability.sourceIds, applicationVerified: true, outputSha256: capability.outputSha256,
            localMediaVerified: true, nativePreviewVerified: true,
            ...(capability.submit ? { submit: capability.submit, limits: 'minimum_text_only_no_size_quality_or_edit' } : { referenceSemantics: 'ordered_references', referenceInfluenceObserved: true, nativePlaybackVerified: true }) };
        insert.run(randomUUID(), provider, baseUrl, capability.model, capability.mode, 'openai', JSON.stringify(capability.parameters),
            'application_verified', APPLICATION_EVIDENCE_VERSION, JSON.stringify(evidence), new Date().toISOString());
    }
    const videoPolicy = require('../tasks/video-policy');
    if (provider === videoPolicy.RULES.provider && baseUrl === videoPolicy.RULES.baseUrl) for (const [model, rule] of Object.entries(videoPolicy.RULES.models)) for (const mode of videoPolicy.MODES) {
        insert.run(randomUUID(),provider,baseUrl,model,mode,'openai',JSON.stringify(rule),'unverified',videoPolicy.RULES.version,
            JSON.stringify({sourceIds:[],applicationVerified:false,submissionPolicy:rule.submissionEnabled?'user-configured-video-parameters':'prepared-awaiting-validation',supplierMaximumReferences:null}),new Date().toISOString());
    }
    seedMultiReferenceCapability(db, provider, baseUrl);
    if (provider === imagePolicy.POLICY.provider && baseUrl === imagePolicy.POLICY.baseUrl) for (const mode of ['image.text','image.reference']) {
        insert.run(randomUUID(), provider, baseUrl, imagePolicy.POLICY.model, mode, imagePolicy.POLICY.protocol, JSON.stringify(imagePolicy.parametersFor(mode)),
            'unverified', imagePolicy.POLICY.evidenceVersion, JSON.stringify(imagePolicy.EVIDENCE), new Date().toISOString());
    }
    if (provider === 'opensosen' && baseUrl === OPENSOSEN_URL) {
        const capability = TEXT_VIDEO_CAPABILITY;
        const evidence = { sourceIds: capability.sourceIds, applicationVerified: true, outputSha256: capability.outputSha256,
            localMediaVerified: true, nativePlaybackVerified: true, dimensions: 'provider_decides',
            submit: { method: 'POST', path: '/videos', encoding: 'multipart', fields: ['model', 'prompt', 'seconds'], seconds: '6', fileParts: 0 },
            observedOutput: { width: 1280, height: 720, durationSeconds: 6.041666666666666 },
            limits: 'text_only_6s_no_size_no_files; observed dimensions are not a request guarantee' };
        insert.run(randomUUID(), provider, baseUrl, capability.model, capability.mode, 'openai', JSON.stringify(capability.parameters),
            'application_verified', TEXT_VIDEO_EVIDENCE_VERSION, JSON.stringify(evidence), new Date().toISOString());
    }
}
function seedMultiReferenceCapability(db, provider, baseUrl) {
    const { POLICY, PARAMETERS, EVIDENCE } = multiReference;
    if (provider !== POLICY.provider || baseUrl !== POLICY.baseUrl) return;
    db.prepare('INSERT OR IGNORE INTO model_capabilities(id,provider,base_url,model,mode,protocol,parameters_json,evidence_level,evidence_version,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), provider, baseUrl, POLICY.model, POLICY.mode, POLICY.protocol, JSON.stringify(PARAMETERS), 'unverified', POLICY.evidenceVersion, JSON.stringify(EVIDENCE), new Date().toISOString());
}
function listCapabilities(db, provider, baseUrl) {
    const rows = db.prepare('SELECT * FROM model_capabilities WHERE provider=? AND base_url=?').all(provider, baseUrl);
    rows.sort((a, b) => a.model.localeCompare(b.model) || a.mode.localeCompare(b.mode) || evidenceRank(b.evidence_level) - evidenceRank(a.evidence_level) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const current = new Set();
    return rows.map(row => {
        const key = JSON.stringify([row.model, row.mode, row.protocol]), isCurrent = !current.has(key); current.add(key);
        return { capabilityVersionId: row.id, provider: row.provider, baseUrl: row.base_url, model: row.model, mode: row.mode, protocol: row.protocol,
            parameters: JSON.parse(row.parameters_json), evidenceLevel: row.evidence_level, evidenceVersion: row.evidence_version, evidence: JSON.parse(row.evidence_json), isCurrent };
    });
}
module.exports = { OPENSOSEN_URL, PRESET_MODELS, EVIDENCE_VERSION, APPLICATION_EVIDENCE_VERSION, APPLICATION_CAPABILITIES, TEXT_VIDEO_EVIDENCE_VERSION, TEXT_VIDEO_CAPABILITY, generationEvidenceVerified, normalizeBaseUrl, seedCapabilities, listCapabilities };
