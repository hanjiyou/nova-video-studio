'use strict';
// Main-process-only bootstrap. No renderer, HTTP route or environment variable can grant this permission.
// This permits one explicitly authorized protocol experiment; it never changes capability evidence.
const { UUID } = require('../storage/store');
const { createHash } = require('node:crypto');
const BASE = 'https://newapi.opensosen.com/v1';
function createControlledImageValidationGate() {
    let configured = false, grant = null;
    function configure(input) {
        const fields = ['localRequestId', 'connectionVersionId', 'capabilityVersionId', 'promptSha256', 'dispatchPermitted'];
        if (configured || !input || Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key)) ||
            !fields.slice(0, 3).every(key => typeof input[key] === 'string' && UUID.test(input[key])) ||
            !/^[a-f0-9]{64}$/.test(input.promptSha256) || typeof input.dispatchPermitted !== 'function') throw new Error('CONTROLLED_VALIDATION_GRANT_INVALID');
        configured = true;
        grant = Object.freeze({ ...input });
    }
    function allows(snapshot, auth, capability) {
        if (!grant || auth.connectionVersionId !== grant.connectionVersionId || auth.provider !== 'opensosen' || auth.baseUrl !== BASE || auth.protocol !== 'openai' ||
            snapshot.mode !== 'image.text' || snapshot.model !== 'gpt-image-2.5-flare' ||
            capability.evidence_level !== 'unverified' || capability.mode !== snapshot.mode || capability.model !== snapshot.model ||
            snapshot.localRequestId !== grant.localRequestId || snapshot.connectionVersionId !== grant.connectionVersionId ||
            snapshot.capabilityVersionId !== grant.capabilityVersionId || capability.id !== grant.capabilityVersionId ||
            !snapshot.parameters || Object.keys(snapshot.parameters).length || !Array.isArray(snapshot.inputAssets) || snapshot.inputAssets.length ||
            typeof snapshot.prompt !== 'string' || createHash('sha256').update(snapshot.prompt).digest('hex') !== grant.promptSha256) return false;
        try { return grant.dispatchPermitted() === true; } catch { return false; }
    }
    return { configure, allows, revoke() { grant = null; } };
}
const controlledImageValidation = createControlledImageValidationGate();
module.exports = { createControlledImageValidationGate, controlledImageValidation };
