'use strict';
// Browser-safe rule resolution shared by the UI and the local task service.
// Registered driver identities describe implemented protocols, not model brands.
const RULES = require('./model-rules.json');
const LEGACY = require('./video-rules-legacy.json');
const { MAX_VIDEO_REFERENCE_ASSETS } = require('../storage/application-limits');
const MODES = Object.freeze(['video.text','video.single_reference','video.dual_reference','video.multi_reference']);
const DRIVER = 'openai-video-multipart-v1';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const own = (value, key) => Boolean(value && Object.hasOwn(value, key));
const validSize = size => typeof size === 'string' && /^[1-9][0-9]*x[1-9][0-9]*$/.test(size) && size.split('x').every(n=>Number.isSafeInteger(Number(n))&&Number(n)>0);
function validRule(rule) {
  return Boolean(rule && rule.profile === DRIVER && Array.isArray(rule.modes) && rule.modes.length && new Set(rule.modes).size===rule.modes.length && rule.modes.every(mode=>MODES.includes(mode)) &&
    Number.isSafeInteger(rule.minSeconds) && rule.minSeconds>0 && (rule.maxSeconds===null || Number.isSafeInteger(rule.maxSeconds) && rule.maxSeconds>=rule.minSeconds) && Number.isSafeInteger(rule.defaultSeconds) && rule.defaultSeconds>=rule.minSeconds && (rule.maxSeconds===null || rule.defaultSeconds<=rule.maxSeconds) &&
    typeof rule.sendSize==='boolean' && (rule.sizeOptional===undefined || typeof rule.sizeOptional==='boolean') && Array.isArray(rule.sizes) && rule.sizes.every(validSize) && (rule.sendSize ? validSize(rule.defaultSize) || rule.sizeOptional===true && rule.defaultSize===null : rule.defaultSize===null && rule.sizes.length===0 && !rule.sizeOptional) &&
    (rule.centsPerSecond===null || Number.isSafeInteger(rule.centsPerSecond)&&rule.centsPerSecond>=0) && typeof rule.submissionEnabled==='boolean' &&
    rule.modes.every(mode=>{const limit=rule.referenceLimits?.[mode];return limit&&Number.isInteger(limit.min)&&Number.isInteger(limit.max)&&limit.min>=0&&limit.max>=limit.min&&limit.max<=MAX_VIDEO_REFERENCE_ASSETS&&
      (mode==='video.text'?limit.min===0&&limit.max===0:mode==='video.single_reference'?limit.min===1&&limit.max===1:mode==='video.dual_reference'?limit.min===2&&limit.max===2:limit.min>=3); }));
}
function videoRule(model, scope, configuration = RULES) {
  const base=scope?.baseUrl||scope?.base_url;
  const supportedBase=base===configuration.baseUrl || configuration.provider==='opensosen' && configuration.baseUrl==='https://newapi.opensosen.com/v1' && base==='https://newapi.opensosen.cn/v1';
  if (scope && (scope.provider!==configuration.provider || !supportedBase || scope.protocol!==undefined&&scope.protocol!=='openai')) return null;
  if (typeof model!=='string' || !MODEL_ID.test(model) || own(Object.prototype,model)) return null;
  // Rule resolution does not classify a model or authorize a submission. The
  // connection catalog grants independent capabilities only to video entries.
  const explicit=own(configuration.models,model), source=explicit?configuration.models[model]:configuration.videoDefaults;
  if (!source || typeof source!=='object' || Array.isArray(source)) return null;
  const entry=explicit?{...configuration.videoDefaults,...source,...(own(source,'sendSize')&&!own(source,'sizeOptional')?{sizeOptional:false}:{})}:source;
  const profile=own(configuration.profiles,entry.profile)?configuration.profiles[entry.profile]:null;
  if (!profile || profile.driver!==DRIVER) return null;
  const rule={...profile,...entry,profile:entry.profile,referenceLimits:{...profile.referenceLimits,...entry.referenceLimits}};
  return validRule(rule)?rule:null;
}
function legacyRule(model, parameters) {
  if (!own(LEGACY.models,model)) return null;
  const profile=LEGACY.profileDefaults;
  const rule={...profile,...parameters,profile:DRIVER,referenceLimits:profile.referenceLimits};
  return validRule(rule)?rule:null;
}
function validParameters(rule, parameters, mode) {
  if(rule&&!validRule(rule)&&own(RULES.profiles,rule.profile)){const profile=RULES.profiles[rule.profile];rule={...profile,...rule,referenceLimits:{...profile.referenceLimits,...rule.referenceLimits}};}
  return Boolean(validRule(rule) && (!mode || rule.modes.includes(mode)) && parameters && typeof parameters==='object' && !Array.isArray(parameters) &&
    validSeconds(rule,parameters.seconds) &&
    Object.keys(parameters).every(key=>(rule.sendSize?['seconds','size']:['seconds']).includes(key)) && (rule.sendSize?(rule.sizeOptional===true&&!own(parameters,'size') || validSize(parameters.size)):!own(parameters,'size')));
}
function validSeconds(rule, seconds) { return Boolean(rule && Number.isSafeInteger(seconds) && seconds>=rule.minSeconds && (rule.maxSeconds===null || seconds<=rule.maxSeconds)); }
function validReferences(rule, mode, assets) {
  const limit=rule?.modes?.includes(mode)?rule.referenceLimits?.[mode]:null;
  return Boolean(limit&&Array.isArray(assets)&&assets.length>=limit.min&&assets.length<=limit.max);
}
function videoRules(scope, models=Object.keys(RULES.models)) { return Object.fromEntries([...new Set(models)].flatMap(model=>{const rule=videoRule(model,scope);return rule?[[model,rule]]:[];})); }
module.exports={RULES,LEGACY,MODES,DRIVER,validRule,videoRule,legacyRule,validParameters,validSeconds,validSize,validReferences,videoRules};
