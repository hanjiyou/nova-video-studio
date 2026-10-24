'use strict';
const POLICY = require('./multi-reference-policy.json');
const { MAX_VIDEO_REFERENCE_ASSETS } = require('../storage/application-limits');
const PARAMETERS = Object.freeze({ seconds: POLICY.seconds, size: POLICY.size, encoding: 'multipart', inputReferenceName: 'input_reference', minimumReferences: POLICY.minimumReferences });
const EVIDENCE = Object.freeze({ sourceIds: [], applicationVerified: false, submissionPolicy: 'explicit-user-action-unverified-multi-reference-v1', supplierMaximumReferences: null, referenceSemantics: 'ordered_references', notice: 'Three or more references have not been tested against the real service. The application resource budget is not a supplier limit.' });
const authorized = new WeakSet();
function exactParameters(value) { return value && Object.keys(value).length === Object.keys(PARAMETERS).length && Object.entries(PARAMETERS).every(([key,item]) => value[key] === item); }
function allowsUnverifiedSubmission(capability, snapshot, auth) {
    if (!capability || capability.evidence_level !== 'unverified' || capability.evidence_version !== POLICY.evidenceVersion || snapshot.mode !== POLICY.mode || snapshot.adapterId !== 'plugin:opensosen-video' || snapshot.adapterVersion !== '1.1.0' ||
        capability.mode !== POLICY.mode || capability.provider !== POLICY.provider || capability.base_url !== POLICY.baseUrl || capability.model !== POLICY.model || capability.protocol !== POLICY.protocol ||
        auth.provider !== POLICY.provider || auth.baseUrl !== POLICY.baseUrl || auth.protocol !== POLICY.protocol || snapshot.model !== POLICY.model ||
        !Array.isArray(snapshot.inputAssets) || snapshot.inputAssets.length < POLICY.minimumReferences || snapshot.inputAssets.length > MAX_VIDEO_REFERENCE_ASSETS) return false;
    try { const evidence = JSON.parse(capability.evidence_json); return exactParameters(JSON.parse(capability.parameters_json)) && evidence.applicationVerified === false && evidence.submissionPolicy === EVIDENCE.submissionPolicy && evidence.supplierMaximumReferences === null && Array.isArray(evidence.sourceIds) && evidence.sourceIds.length === 0; }
    catch { return false; }
}
function authorizeContext(context, snapshot, auth, capability) {
    if (!allowsUnverifiedSubmission(capability, snapshot, auth) || context.mode !== POLICY.mode || context.baseUrl !== POLICY.baseUrl || context.model !== POLICY.model || context.connectionVersionId !== snapshot.connectionVersionId) throw Object.assign(new Error('Unverified multi-reference scope is not authorized.'), { code: 'CAPABILITY_UNVERIFIED' });
    authorized.add(context);
}
module.exports = { POLICY, PARAMETERS, EVIDENCE, allowsUnverifiedSubmission, authorizeContext, isAuthorizedContext: context => authorized.has(context) };
