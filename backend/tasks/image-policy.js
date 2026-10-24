'use strict';
const POLICY = require('./image-policy.json');
const EVIDENCE = Object.freeze({ sourceIds: [], applicationVerified: false, submissionPolicy: POLICY.submissionPolicy,
    officialReference: 'https://developers.openai.com/api/reference/resources/images/methods/edit',
    notice: 'Standard image parameters and single-file edits have not been tested against this relay.' });
function parametersFor(mode) {
    return { sizes: POLICY.sizes, qualities: POLICY.qualities, encoding: mode === 'image.reference' ? 'multipart' : 'json',
        referenceCount: mode === 'image.reference' ? 1 : 0, ...(mode === 'image.reference' ? { inputReferenceName: 'image' } : {}) };
}
function validParameters(parameters) {
    return parameters && typeof parameters === 'object' && !Array.isArray(parameters) &&
        Object.keys(parameters).every(key => key === 'size' ? POLICY.sizes.includes(parameters[key]) : key === 'quality' && POLICY.qualities.includes(parameters[key]));
}
function exactParameters(value, mode) {
    const expected = parametersFor(mode);
    return value && Object.keys(value).length === Object.keys(expected).length && Object.entries(expected).every(([key,item]) => JSON.stringify(value[key]) === JSON.stringify(item));
}
function allowsUnverifiedSubmission(capability, snapshot, auth) {
    if (!capability || capability.evidence_level !== 'unverified' || capability.evidence_version !== POLICY.evidenceVersion ||
        !['image.text','image.reference'].includes(snapshot.mode) || snapshot.adapterId !== 'opensosen-flare-image' || snapshot.adapterVersion !== '1.1.0' ||
        capability.mode !== snapshot.mode || capability.provider !== POLICY.provider || capability.base_url !== POLICY.baseUrl || capability.model !== POLICY.model || capability.protocol !== POLICY.protocol ||
        auth.provider !== POLICY.provider || auth.baseUrl !== POLICY.baseUrl || auth.protocol !== POLICY.protocol || snapshot.model !== POLICY.model ||
        !validParameters(snapshot.parameters) || !Array.isArray(snapshot.inputAssets) || snapshot.inputAssets.length !== (snapshot.mode === 'image.reference' ? 1 : 0) ||
        snapshot.mode === 'image.text' && !Object.keys(snapshot.parameters).length) return false;
    try { const evidence = JSON.parse(capability.evidence_json); return exactParameters(JSON.parse(capability.parameters_json), snapshot.mode) &&
        evidence.applicationVerified === false && evidence.submissionPolicy === POLICY.submissionPolicy && Array.isArray(evidence.sourceIds) && evidence.sourceIds.length === 0; }
    catch { return false; }
}
module.exports = { POLICY, EVIDENCE, parametersFor, validParameters, allowsUnverifiedSubmission };
