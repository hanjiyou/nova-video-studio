'use strict';
const POLICY = require('./image-policy.json');
// These identify implemented wire protocols, never a claim that arbitrary endpoints are compatible.
const PROFILES = Object.freeze(['openai-images-v1']);
const ADAPTER_ID = 'opensosen-flare-image', ADAPTER_VERSION = '1.1.0';
const MODES = Object.freeze(['image.text', 'image.reference']);
const EVIDENCE = Object.freeze({ sourceIds: [], applicationVerified: false, submissionPolicy: POLICY.submissionPolicy,
    configuredProtocol: 'openai-images-v1', submissionEnabled: true,
    officialReference: 'https://developers.openai.com/api/reference/resources/images/methods/edit',
    notice: 'User-configured standard image protocol; relay generation and edits remain unverified.' });
const LEGACY_EVIDENCE = Object.freeze({ sourceIds: [], applicationVerified: false, submissionPolicy: POLICY.legacySubmissionPolicy,
    officialReference: 'https://developers.openai.com/api/reference/resources/images/methods/edit',
    notice: 'Standard image parameters and single-file edits have not been tested against this relay.' });
function imageRule(model, scope) {
    if (scope && (scope.provider !== POLICY.provider || (scope.baseUrl || scope.base_url) !== POLICY.baseUrl ||
        scope.protocol !== undefined && scope.protocol !== POLICY.protocol)) return null;
    if (typeof model !== 'string' || !Object.hasOwn(POLICY.models, model)) return null;
    const configured = POLICY.models[model], profile = POLICY.profiles[configured.profile];
    if (!PROFILES.includes(configured.profile) || !profile) return null;
    const rule = { ...profile, ...configured, model, provider: POLICY.provider, baseUrl: POLICY.baseUrl, protocol: POLICY.protocol,
        adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION };
    if (typeof rule.submissionEnabled !== 'boolean' || !Array.isArray(rule.modes) || rule.modes.some(mode => !MODES.includes(mode)) ||
        !Array.isArray(rule.sizes) || !Array.isArray(rule.qualities) ||
        [...rule.sizes, ...rule.qualities].some(value => typeof value !== 'string' || !value || value.length > 64)) return null;
    return rule;
}
function parametersFor(mode, model = POLICY.model, legacy = false) {
    const rule = legacy ? POLICY : imageRule(model);
    if (!rule || !MODES.includes(mode) || !legacy && !rule.modes.includes(mode)) return null;
    return { sizes: rule.sizes, qualities: rule.qualities, encoding: mode === 'image.reference' ? 'multipart' : 'json',
        referenceCount: mode === 'image.reference' ? 1 : 0, ...(mode === 'image.reference' ? { inputReferenceName: 'image' } : {}) };
}
function validParameters(parameters, model = POLICY.model, mode) {
    const rule = imageRule(model);
    return Boolean(rule && (!mode || rule.modes.includes(mode)) && parameters && typeof parameters === 'object' && !Array.isArray(parameters) &&
        Object.keys(parameters).every(key => key === 'size' ? rule.sizes.includes(parameters[key]) : key === 'quality' && rule.qualities.includes(parameters[key])));
}
function exactParameters(value, mode, model, legacy) {
    const expected = parametersFor(mode, model, legacy);
    return Boolean(expected && value && Object.keys(value).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key,item]) => JSON.stringify(value[key]) === JSON.stringify(item)));
}
function allowsNewSubmission(snapshot, auth) {
    const rule = imageRule(snapshot.model, auth);
    return Boolean(rule && rule.submissionEnabled === true && rule.modes.includes(snapshot.mode) && validParameters(snapshot.parameters, snapshot.model, snapshot.mode));
}
function allowsUnverifiedSubmission(capability, snapshot, auth) {
    const rule = imageRule(snapshot.model, auth), legacy = capability?.evidence_version === POLICY.legacyEvidenceVersion;
    if (!rule || !capability || capability.evidence_level !== 'unverified' ||
        ![POLICY.evidenceVersion, POLICY.legacyEvidenceVersion].includes(capability.evidence_version) ||
        !rule.modes.includes(snapshot.mode) || snapshot.adapterId !== ADAPTER_ID || snapshot.adapterVersion !== ADAPTER_VERSION ||
        capability.mode !== snapshot.mode || capability.provider !== rule.provider || capability.base_url !== rule.baseUrl ||
        capability.model !== snapshot.model || capability.protocol !== rule.protocol ||
        legacy && snapshot.model !== POLICY.model || !validParameters(snapshot.parameters, snapshot.model, snapshot.mode) ||
        !Array.isArray(snapshot.inputAssets) || snapshot.inputAssets.length !== (snapshot.mode === 'image.reference' ? 1 : 0) ||
        legacy && snapshot.mode === 'image.text' && !Object.keys(snapshot.parameters).length) return false;
    try {
        const evidence = JSON.parse(capability.evidence_json);
        return exactParameters(JSON.parse(capability.parameters_json), snapshot.mode, snapshot.model, legacy) &&
            evidence.applicationVerified === false && evidence.submissionPolicy === (legacy ? POLICY.legacySubmissionPolicy : POLICY.submissionPolicy) &&
            Array.isArray(evidence.sourceIds) && evidence.sourceIds.length === 0 &&
            (legacy || evidence.configuredProtocol === rule.profile && evidence.submissionEnabled === true);
    } catch { return false; }
}
module.exports = { POLICY, PROFILES, MODES, ADAPTER_ID, ADAPTER_VERSION, EVIDENCE, LEGACY_EVIDENCE, imageRule, parametersFor, validParameters, allowsNewSubmission, allowsUnverifiedSubmission };
