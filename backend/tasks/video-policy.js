'use strict';
const { RULES, videoRule, validParameters } = require('../connections/model-catalog');
const authorized = new WeakSet();
const MODES = ['video.text','video.single_reference','video.dual_reference','video.multi_reference'];
function matches(capability, snapshot, auth) {
    const rule = videoRule(snapshot.model, auth);
    return Boolean(rule && capability && capability.evidence_version === RULES.version && capability.evidence_level === 'unverified' && capability.provider === auth.provider && capability.base_url === auth.baseUrl && capability.protocol === auth.protocol && capability.model === snapshot.model && capability.mode === snapshot.mode && MODES.includes(snapshot.mode) && validParameters(rule,snapshot.parameters));
}
function allows(capability, snapshot, auth) { return matches(capability,snapshot,auth) && videoRule(snapshot.model,auth).submissionEnabled; }
function authorizeContext(context,snapshot,auth,capability) { if (allows(capability,snapshot,auth) && context.model===snapshot.model && context.mode===snapshot.mode && context.baseUrl===auth.baseUrl && context.connectionVersionId===snapshot.connectionVersionId && context.fields?.prompt===snapshot.prompt && JSON.stringify(context.parameters)===JSON.stringify(snapshot.parameters)) authorized.add(context); }
function descriptor(context) {
    const rule = videoRule(context.model,context);
    if (!validParameters(rule,context.parameters)) throw Object.assign(new Error('视频参数无效。'),{code:'INPUT_INVALID'});
    return [{kind:'field',name:'seconds',value:String(context.parameters.seconds)}, ...(rule.sendSize?[{kind:'field',name:'size',value:context.parameters.size}]:[])];
}
module.exports = { RULES, MODES, matches, allows, authorizeContext, descriptor, isAuthorizedContext: context=>authorized.has(context) };
