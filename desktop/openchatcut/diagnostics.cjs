'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{performance}=require('node:perf_hooks');
const {ERROR_NAMES,SYSTEM_CODES,CATEGORIES,SERVICE_PHASES,EDITOR_CODES}=require('./diagnostic-fields.cjs');
const LIMIT=240,MAX_BYTES=192*1024;
const EVENTS=new Set('session_started open_requested open_reused open_coalesced preflight_started preflight_completed preflight_failed service_spawn_started service_spawned service_phase service_ready service_error service_exit service_stderr view_created page_load_started page_dom_ready page_loaded page_load_failed shell_wait_started shell_ready shell_timeout renderer_gone console_error startup_failed startup_timeout startup_completed stop_requested stop_completed service_force_killed'.split(' '));
const STAGES=new Set(['preflight','spawn','service-start','page-load','shell-ready','ready','stop']);
const REASONS=new Set(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction']);
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function project(value){if(!value||!EVENTS.has(value.event))return null;const out={event:value.event};
  for(const key of ['sessionId','attemptId'])if(typeof value[key]==='string'&&UUID.test(value[key]))out[key]=value[key];
  if(typeof value.at==='string'&&Number.isFinite(Date.parse(value.at)))out.at=new Date(value.at).toISOString();
  if(typeof value.currentVersion==='string'&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.currentVersion)&&value.currentVersion.length<=48)out.currentVersion=value.currentVersion;
  for(const key of ['elapsedMs','stageElapsedMs','serviceElapsedMs','deadlineMs','stderrBytes','lineNumber'])if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=Number.MAX_SAFE_INTEGER)out[key]=value[key];
  if(STAGES.has(value.stage))out.stage=value.stage;if(SERVICE_PHASES.has(value.servicePhase))out.servicePhase=value.servicePhase;
  if(EDITOR_CODES.has(value.code))out.code=value.code;
  if(['SIGTERM','SIGKILL','SIGINT','SIGABRT'].includes(value.signal))out.signal=value.signal;
  if(ERROR_NAMES.has(value.errorName))out.errorName=value.errorName;if(SYSTEM_CODES.has(value.systemCode))out.systemCode=value.systemCode;if(CATEGORIES.has(value.category))out.category=value.category;
  if(REASONS.has(value.reason))out.reason=value.reason;
  for(const key of ['exitCode','netErrorCode'])if(Number.isSafeInteger(value[key])&&value[key]>=-2147483648&&value[key]<=4294967295)out[key]=value[key];
  if(typeof value.mainFrame==='boolean')out.mainFrame=value.mainFrame;
  return out;
}
function createEditorDiagnostics({directory,currentVersion,io=fs,now=Date.now,clock=()=>performance.now()}){
  const file=path.join(directory,'editor-diagnostics.json'),sessionId=randomUUID();let events=[],omitted=0,writeFailures=0;
  try{const stat=io.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error();const old=JSON.parse(io.readFileSync(file,'utf8'));events=(Array.isArray(old.events)?old.events:[]).map(project).filter(Boolean).slice(-LIMIT);omitted=Number.isSafeInteger(old.omitted)&&old.omitted>=0?old.omitted:0;}catch{}
  function persist(){let fd;const temporary=file+'.'+randomUUID()+'.tmp';try{io.mkdirSync(directory,{recursive:true});try{const stat=io.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error();}catch(error){if(error.code!=='ENOENT')throw error;}fd=io.openSync(temporary,'wx',0o600);io.writeFileSync(fd,JSON.stringify({format:'nova-editor-diagnostics-v1',omitted,writeFailures,events}));io.closeSync(fd);fd=undefined;io.renameSync(temporary,file);}catch{writeFailures++;if(fd!==undefined)try{io.closeSync(fd);}catch{}}finally{try{io.unlinkSync(temporary);}catch{}}}
  function append(event,fields){const item=project({...fields,event,sessionId,currentVersion,at:new Date(now()).toISOString()});if(!item)return;events.push(item);if(events.length>LIMIT){omitted+=events.length-LIMIT;events=events.slice(-LIMIT);}persist();}
  append('session_started',{});
  return {begin(){const attemptId=randomUUID(),started=clock();let consoleCount=0;return (event,fields={})=>{if(event==='console_error'&&consoleCount++>=8){omitted++;return;}append(event,{...fields,attemptId,elapsedMs:Math.max(0,Math.round(clock()-started))});};},snapshot(){return {format:'nova-editor-diagnostics-v1',omitted,writeFailures,events:events.map(project)};}};
}
module.exports={createEditorDiagnostics,project,LIMIT,MAX_BYTES};
