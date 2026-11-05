import rules from '../../../backend/connections/model-rules.json';
import { classify } from '../../../backend/connections/model-catalog';
import { videoRule as resolveVideoRule, validParameters, validReferences } from '../../../backend/connections/video-rules';
import { sameConnectionTransport, type ConnectionModels, type ConnectionSummary, type CapabilitySummary } from './connection-client';
export type VideoRule = {profile:string;modes:string[];referenceLimits:Record<string,{min:number;max:number}>;minSeconds:number;maxSeconds:number;defaultSeconds:number;sendSize:boolean;sizes:string[];defaultSize:string|null;centsPerSecond:number|null;submissionEnabled:boolean};
export function videoRule(model:string,connection:ConnectionSummary|null,models?:ConnectionModels|null):VideoRule|null {
  if(!connection)return null;
  if(models?.videoRules){if(!sameConnectionTransport(connection,models))return null;return Object.hasOwn(models.videoRules,model)?models.videoRules[model]:null;}
  return resolveVideoRule(model,connection) as VideoRule|null;
}
export function configuredVideo(capability:CapabilitySummary|undefined) {return capability?.evidenceVersion===rules.version && capability.evidenceLevel==='unverified' && capability.configurationCurrent!==false;}
export function validVideoParameters(rule:VideoRule,p:Record<string,unknown>,mode?:string) {return validParameters(rule,p,mode);}
export const validVideoReferences=(rule:VideoRule,mode:string,assets:unknown[])=>validReferences(rule,mode,assets);
export function validVideoSize(size:unknown) {return typeof size==='string' && /^[1-9][0-9]*x[1-9][0-9]*$/.test(size) && size.split('x').every(n=>Number.isSafeInteger(Number(n))&&Number(n)>0);}
export function classifiedModels(models: ConnectionModels | null, kind: 'image' | 'video') {
  return (models?.models || []).filter(item => (item.categories || classify(item.model, item.endpointTypes).categories).includes(kind));
}
export function modelOptions(models: ConnectionModels | null, kind: 'image' | 'video', selected = '', connection?: ConnectionSummary | null) {
  if (connection && models && !sameConnectionTransport(connection,models)) return [];
  const allowed = models?.displaySettings?.[kind === 'image' ? 'imageModels' : 'videoModels'];
  const entries = classifiedModels(models, kind).filter(item => (item.visibility === 'visible' || item.custom) && (!allowed || allowed.includes(item.model))).map(item => item.model);
  // Old hosts retain their historical placeholder; new hosts never expose hidden choices.
  return [...new Set(allowed ? entries : [selected, ...entries])].filter(Boolean);
}
export function modelHidden(models: ConnectionModels | null, kind: 'image' | 'video', model: string, connection?: ConnectionSummary | null) {
  if (connection && models && !sameConnectionTransport(connection,models)) return false;
  const settings = models?.displaySettings;
  return Boolean(model && settings && !settings[kind === 'image' ? 'imageModels' : 'videoModels'].includes(model));
}
export function defaultModel(connection: ConnectionSummary | null, models: ConnectionModels | null, kind: 'image' | 'video') {
  const key = kind === 'image' ? 'defaultImageModel' : 'defaultVideoModel';
  if (connection && models && !sameConnectionTransport(connection,models)) return '';
  return models?.displaySettings ? models.displaySettings[key] || '' : connection?.[key] || '';
}
export function videoDefaults(model:string,rule:VideoRule,models:ConnectionModels|null) {const stored=models?.modelSettings?.[model]?.defaultSeconds;return {seconds:stored && Number.isInteger(stored)&&stored>=rule.minSeconds&&stored<=rule.maxSeconds?stored:rule.defaultSeconds,...(rule.sendSize?{size:rule.defaultSize || rule.sizes[0]}:{})};}
export function videoPrice(rule:VideoRule|null,seconds:unknown) {return rule&&rule.centsPerSecond!==null&&Number.isSafeInteger(rule.centsPerSecond)&&Number.isInteger(seconds)&&Number(seconds)>=rule.minSeconds&&Number(seconds)<=rule.maxSeconds?((Number(seconds)*rule.centsPerSecond)/100).toFixed(2):null;}

export function modelSubmissionEnabled(item: ConnectionModels['models'][number], kind: 'image' | 'video') {
  return item.submissionEnabledByKind ? item.submissionEnabledByKind[kind] === true : item.submissionEnabled === true;
}
/** A delayed response cannot roll back an acknowledged display configuration. */
export function acceptModelSnapshot(connection: ConnectionSummary, current: ConnectionModels | null, incoming: ConnectionModels) {
  if (!sameConnectionTransport(connection,incoming)) return current;
  if (current && sameConnectionTransport(connection,current) && current.displaySettings && (!incoming.displaySettings || incoming.displaySettings.revision < current.displaySettings.revision)) return current;
  return incoming;
}
