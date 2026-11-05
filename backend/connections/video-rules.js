'use strict';
// Browser-safe rule resolution shared by the UI and the local task service.
// Registered driver identities describe implemented protocols, not model brands.
const RULES = require('./model-rules.json');
const LEGACY = require('./video-rules-legacy.json');
const { MAX_VIDEO_REFERENCE_ASSETS } = require('../storage/application-limits');
const MODES = Object.freeze(['video.text','video.single_reference','video.dual_reference','video.multi_reference']);
const DRIVER = 'openai-video-multipart-v1';
const own = (value, key) => Boolean(value && Object.hasOwn(value, key));
const validSize = size => typeof size === 'string' && /^[1-9][0-9]*x[1-9][0-9]*$/.test(size) && size.split('x').every(n=>Number.isSafeInteger(Number(n))&&Number(n)>0);
function validRule(rule) {
  return Boolean(rule && rule.profile === DRIVER && Array.isArray(rule.modes) && rule.modes.length && new Set(rule.modes).size===rule.modes.length && rule.modes.every(mode=>MODES.includes(mode)) &&
    Number.isSafeInteger(rule.minSeconds) && rule.minSeconds>0 && Number.isSafeInteger(rule.maxSeconds) && rule.maxSeconds>=rule.minSeconds && Number.isSafeInteger(rule.defaultSeconds) && rule.defaultSeconds>=rule.minSeconds && rule.defaultSeconds<=rule.maxSeconds &&
    typeof rule.sendSize==='boolean' && Array.isArray(rule.sizes) && rule.sizes.every(validSize) && (rule.sendSize ? validSize(rule.defaultSize) : rule.defaultSize===null && rule.sizes.length===0) &&
    (rule.centsPerSecond===null || Number.isSafeInteger(rule.centsPerSecond)&&rule.centsPerSecond>=0) && typeof rule.submissionEnabled==='boolean' &&
    rule.modes.every(mode=>{const limit=rule.referenceLimits?.[mode];return limit&&Number.isInteger(limit.min)&&Number.isInteger(limit.max)&&limit.min>=0&&limit.max>=limit.min&&limit.max<=MAX_VIDEO_REFERENCE_ASSETS&&
      (mode==='video.text'?limit.min===0&&limit.max===0:mode==='video.single_reference'?limit.min===1&&limit.max===1:mode==='video.dual_reference'?limit.min===2&&limit.max===2:limit.min>=3); }));
}
function videoRule(model, scope, configuration = RULES) {
  if (scope && (scope.provider!==configuration.provider || (scope.baseUrl||scope.base_url)!==configuration.baseUrl || scope.protocol!==undefined&&scope.protocol!=='openai')) return null;
  if (!own(configuration.models, model)) return null;
  const entry=configuration.models[model];
  if (!entry || typeof entry!=='object' || Array.isArray(entry)) return null;
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
    Number.isInteger(parameters.seconds)&&parameters.seconds>=rule.minSeconds&&parameters.seconds<=rule.maxSeconds &&
    Object.keys(parameters).every(key=>(rule.sendSize?['seconds','size']:['seconds']).includes(key)) && (rule.sendSize?validSize(parameters.size):!own(parameters,'size')));
}
function validReferences(rule, mode, assets) {
  const limit=rule?.modes?.includes(mode)?rule.referenceLimits?.[mode]:null;
  return Boolean(limit&&Array.isArray(assets)&&assets.length>=limit.min&&assets.length<=limit.max);
}
function videoRules(scope) { return Object.fromEntries(Object.keys(RULES.models).flatMap(model=>{const rule=videoRule(model,scope);return rule?[[model,rule]]:[];})); }
module.exports={RULES,LEGACY,MODES,DRIVER,validRule,videoRule,legacyRule,validParameters,validSize,validReferences,videoRules};
