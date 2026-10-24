'use strict';
// Main-process-only context authority: exact verified text protocol or one controlled candidate. No renderer bypass.
const { UUID } = require('../storage/store');
const { createHash } = require('node:crypto');
const { generationEvidenceVerified, TEXT_VIDEO_EVIDENCE_VERSION } = require('../connections/capabilities');
const BASE = 'https://newapi.opensosen.com/v1';
function createControlledVideoTextValidationGate() {
    let configured = false, grant = null;
    const contexts = new WeakMap();
    function configure(input) {
        const fields = ['localRequestId', 'connectionVersionId', 'capabilityVersionId', 'promptSha256', 'dispatchPermitted'];
        if (configured || !input || ![fields.length, fields.length + 1].includes(Object.keys(input).length) ||
            Object.keys(input).some(key => ![...fields, 'candidate'].includes(key)) ||
            (Object.hasOwn(input, 'candidate') && !['with-size', 'without-size'].includes(input.candidate)) ||
            !fields.slice(0, 3).every(key => typeof input[key] === 'string' && UUID.test(input[key])) ||
            !/^[a-f0-9]{64}$/.test(input.promptSha256) || typeof input.dispatchPermitted !== 'function') throw new Error('CONTROLLED_VIDEO_TEXT_GRANT_INVALID');
        configured = true;
        grant = Object.freeze({ ...input, candidate: input.candidate || 'with-size' });
    }
    function matchesParameters(parameters) {
        return Boolean(grant && parameters && !Array.isArray(parameters) && parameters.seconds === 6 &&
            (grant.candidate === 'without-size' ? Object.keys(parameters).length === 1 && Object.hasOwn(parameters, 'seconds') :
                Object.keys(parameters).length === 2 && parameters.size === '1280x720'));
    }
    function allowsInput(snapshot) {
        if (!grant || !snapshot || snapshot.mode !== 'video.text' || snapshot.model !== 'grok-imagine-video-1.5-6s' ||
            snapshot.localRequestId !== grant.localRequestId || snapshot.connectionVersionId !== grant.connectionVersionId ||
            snapshot.capabilityVersionId !== grant.capabilityVersionId || !matchesParameters(snapshot.parameters) ||
            !Array.isArray(snapshot.inputAssets) || snapshot.inputAssets.length || typeof snapshot.prompt !== 'string' ||
            createHash('sha256').update(snapshot.prompt).digest('hex') !== grant.promptSha256) return false;
        try { return grant.dispatchPermitted() === true; } catch { return false; }
    }
    function allows(snapshot, auth, capability) {
        return Boolean(allowsInput(snapshot) && auth && capability && auth.connectionVersionId === grant.connectionVersionId &&
            auth.provider === 'opensosen' && auth.baseUrl === BASE && auth.protocol === 'openai' &&
            capability.evidence_level === 'unverified' && capability.mode === snapshot.mode && capability.model === snapshot.model &&
            capability.provider === auth.provider && capability.base_url === BASE && capability.protocol === 'openai' &&
            capability.id === grant.capabilityVersionId);
    }
    function applicationAllows(snapshot, auth, capability) {
        if (!snapshot || !auth || !capability || !generationEvidenceVerified(capability) || capability.evidence_version !== TEXT_VIDEO_EVIDENCE_VERSION ||
            auth.provider !== 'opensosen' || auth.baseUrl !== BASE || auth.protocol !== 'openai' || snapshot.connectionVersionId !== auth.connectionVersionId ||
            capability.provider !== auth.provider || capability.base_url !== BASE || capability.protocol !== 'openai' || capability.id !== snapshot.capabilityVersionId ||
            capability.model !== 'grok-imagine-video-1.5-6s' || capability.mode !== 'video.text' || snapshot.model !== capability.model || snapshot.mode !== capability.mode ||
            !Array.isArray(snapshot.inputAssets) || snapshot.inputAssets.length || typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim() ||
            !snapshot.parameters || snapshot.parameters.seconds !== 6 || Object.keys(snapshot.parameters).length !== 1) return false;
        try { const p = JSON.parse(capability.parameters_json); return p.seconds === 6 && p.encoding === 'multipart' && p.referenceCount === 0 && Object.keys(p).length === 3; }
        catch { return false; }
    }
    function authorizeContext(context, snapshot, auth, capability) {
        if (applicationAllows(snapshot, auth, capability)) contexts.set(context, { snapshot, auth, capability, application: true, candidate: 'without-size' });
        else if (allows(snapshot, auth, capability)) contexts.set(context, { snapshot, auth, capability, candidate: grant.candidate });
    }
    function isAuthorizedContext(context) {
        const saved = contexts.get(context);
        return Boolean(saved && (saved.application ? applicationAllows(saved.snapshot, saved.auth, saved.capability) : allows(saved.snapshot, saved.auth, saved.capability)) && context.mode === saved.snapshot.mode &&
            context.model === saved.snapshot.model && context.baseUrl === BASE && context.connectionVersionId === saved.auth.connectionVersionId &&
            context.fields?.prompt === saved.snapshot.prompt && (saved.application ? context.parameters?.seconds === 6 && Object.keys(context.parameters).length === 1 : matchesParameters(context.parameters)) &&
            Array.isArray(context.inputAssets) && context.inputAssets.length === 0);
    }
    function candidateFor(context) { return isAuthorizedContext(context) ? contexts.get(context).candidate : null; }
    return { configure, allowsInput, allows, authorizeContext, isAuthorizedContext, candidateFor, revoke() { grant = null; } };
}
const controlledVideoTextValidation = createControlledVideoTextValidationGate();
module.exports = { createControlledVideoTextValidationGate, controlledVideoTextValidation };
