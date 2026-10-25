import rules from '../../../backend/connections/model-rules.json';
import { classify } from '../../../backend/connections/model-catalog';
import type { ConnectionModels,ConnectionSummary,CapabilitySummary } from './connection-client';
export type VideoRule = {minSeconds:number;maxSeconds:number;defaultSeconds:number;sendSize:boolean;sizes:string[];defaultSize:string|null;centsPerSecond:number;submissionEnabled:boolean};
export function videoRule(model:string,connection:ConnectionSummary|null):VideoRule|null {return connection?.provider===rules.provider && connection.baseUrl===rules.baseUrl ? (rules.models as Record<string,VideoRule>)[model] || null:null;}
export function configuredVideo(capability:CapabilitySummary|undefined) {return capability?.evidenceVersion===rules.version && capability.evidenceLevel==='unverified';}
export function validVideoParameters(rule:VideoRule,p:Record<string,unknown>) {
  return Number.isInteger(p.seconds) && Number(p.seconds)>=rule.minSeconds && Number(p.seconds)<=rule.maxSeconds && Object.keys(p).every(key=>(rule.sendSize?['seconds','size']:['seconds']).includes(key)) && (rule.sendSize?validVideoSize(p.size):!Object.hasOwn(p,'size'));
}
export function validVideoSize(size:unknown) {return typeof size==='string' && /^[1-9][0-9]*x[1-9][0-9]*$/.test(size) && size.split('x').every(n=>Number.isSafeInteger(Number(n))&&Number(n)>0);}
export function modelOptions(models:ConnectionModels|null,kind:'image'|'video',selected:string) {
  const entries=(models?.models || []).filter(item=>(item.visibility==='visible'||item.custom) && (item.categories || classify(item.model,item.endpointTypes).categories).includes(kind)).map(item=>item.model);
  return [...new Set([selected,...entries])].filter(Boolean);
}
export function videoDefaults(model:string,rule:VideoRule,models:ConnectionModels|null) {const stored=models?.modelSettings?.[model]?.defaultSeconds;return {seconds:stored && Number.isInteger(stored)&&stored>=rule.minSeconds&&stored<=rule.maxSeconds?stored:rule.defaultSeconds,...(rule.sendSize?{size:rule.defaultSize || rule.sizes[0]}:{})};}
export function videoPrice(rule:VideoRule|null,seconds:unknown) {return rule&&Number.isInteger(seconds)&&Number(seconds)>=rule.minSeconds&&Number(seconds)<=rule.maxSeconds?((Number(seconds)*rule.centsPerSecond)/100).toFixed(2):null;}
