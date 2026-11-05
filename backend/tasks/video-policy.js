'use strict';
const { RULES,LEGACY,MODES,videoRule,legacyRule,validRule,validParameters,validReferences }=require('../connections/video-rules');
const authorized=new WeakMap();
function frozenRule(capability) {
  try {
    const parameters=JSON.parse(capability.parameters_json);
    if(capability.evidence_version===LEGACY.version)return legacyRule(capability.model,parameters);
    // Immutable snapshots remain executable after the current configuration
    // version changes. The stored policy and implemented protocol are authority.
    if(!validRule(parameters))return null;
    const evidence=JSON.parse(capability.evidence_json);
    return evidence.submissionPolicy==='configured-video-profile-v1'&&evidence.configuredProtocol===parameters.profile&&evidence.submissionEnabled===parameters.submissionEnabled?parameters:null;
  }catch{return null;}
}
function matches(capability,snapshot,auth) {
  const rule=frozenRule(capability);
  return Boolean(rule&&capability.evidence_level==='unverified'&&capability.provider===auth.provider&&capability.base_url===auth.baseUrl&&capability.protocol===auth.protocol&&capability.model===snapshot.model&&capability.mode===snapshot.mode&&validParameters(rule,snapshot.parameters,snapshot.mode)&&validReferences(rule,snapshot.mode,snapshot.inputAssets));
}
function allows(capability,snapshot,auth){return matches(capability,snapshot,auth)&&frozenRule(capability).submissionEnabled;}
function allowsNewSubmission(snapshot,auth){const rule=videoRule(snapshot.model,auth);return Boolean(rule?.submissionEnabled&&validParameters(rule,snapshot.parameters,snapshot.mode)&&validReferences(rule,snapshot.mode,snapshot.inputAssets));}
function authorizeContext(context,snapshot,auth,capability){if(allows(capability,snapshot,auth)&&context.model===snapshot.model&&context.mode===snapshot.mode&&context.baseUrl===auth.baseUrl&&context.connectionVersionId===snapshot.connectionVersionId&&context.fields?.prompt===snapshot.prompt&&JSON.stringify(context.parameters)===JSON.stringify(snapshot.parameters)&&JSON.stringify(context.inputAssets?.map(({assetId,position,role})=>({assetId,position,role})))===JSON.stringify(snapshot.inputAssets))authorized.set(context,frozenRule(capability));}
function descriptor(context){const rule=authorized.get(context)||videoRule(context.model,context);if(!validParameters(rule,context.parameters,context.mode))throw Object.assign(new Error('视频参数无效。'),{code:'INPUT_INVALID'});return [{kind:'field',name:'seconds',value:String(context.parameters.seconds)},...(rule.sendSize?[{kind:'field',name:'size',value:context.parameters.size}]:[])];}
module.exports={RULES,MODES,matches,allows,allowsNewSubmission,authorizeContext,descriptor,isAuthorizedContext:context=>authorized.has(context),contextRule:context=>authorized.get(context),frozenRule};
