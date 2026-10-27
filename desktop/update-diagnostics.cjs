'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {classifyError,CATEGORIES}=require('../backend/tasks/diagnostic-error');
const LIMIT=400,MAX_BYTES=512*1024;
const EVENTS=new Set('session_started backend_ready window_loaded startup_failed window_failed check_started available no_update check_failed download_started download_progress downloaded download_failed prepare_started backend_prepared flush_requested flush_complete flush_failed backend_close_started backend_closed install_requested installer_spawn_requested installer_spawned installer_error installer_confirm_timeout installer_exit_observed parent_quit_requested install_failed prepare_failed target_version_started previous_install_unconfirmed differential_started differential_downloading differential_fallback differential_checksum_mismatch differential_unavailable download_cache_reused'.split(' '));
const DOWNLOAD_MODES=new Set(['preparing','differential-attempt','differential','full','full-fallback','cached','unknown']);
const FALLBACK_REASONS=new Set(['old_installer_missing','old_installer_unreadable','blockmap_failed','transfer_failed','checksum_failed','unknown']);
const BASELINE_REASONS=new Set(['cache_missing','baseline_missing','baseline_invalid','identity_mismatch','version_mismatch','installer_missing','installer_unreadable','installer_corrupt','cache_changed','map_unusable','cache_invalid','unknown']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const version=v=>typeof v==='string'&&v.length<=32&&/^\d+\.\d+\.\d+$/.test(v)?v:undefined;
function project(value={}) {
  if(!EVENTS.has(value.event))return null;
  const out={event:value.event};
  if(DOWNLOAD_MODES.has(value.downloadMode))out.downloadMode=value.downloadMode;
  if(FALLBACK_REASONS.has(value.fallbackReason))out.fallbackReason=value.fallbackReason;
  if(BASELINE_REASONS.has(value.baselineReason))out.baselineReason=value.baselineReason;
  for(const key of ['sessionId','attemptId','previousAttemptId'])if(typeof value[key]==='string'&&UUID.test(value[key]))out[key]=value[key];
  for(const key of ['currentVersion','targetVersion'])if(version(value[key]))out[key]=value[key];
  if(typeof value.at==='string'&&Number.isFinite(Date.parse(value.at)))out.at=new Date(value.at).toISOString();
  for(const key of ['elapsedMs','transferred','total','bytesPerSecond','percent'])if(Number.isSafeInteger(value[key])&&value[key]>=0)out[key]=key==='percent'?Math.min(100,value[key]):value[key];
  if(Number.isSafeInteger(value.exitCode)&&value.exitCode>=-2147483648&&value.exitCode<=4294967295)out.exitCode=value.exitCode;
  if(['SIGTERM','SIGKILL','SIGINT','SIGABRT'].includes(value.signal))out.signal=value.signal;
  if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)out.httpStatus=value.httpStatus;
  if(CATEGORIES.has(value.errorCategory))out.errorCategory=value.errorCategory;
  if(['UPDATE_CHECK_FAILED','UPDATE_DOWNLOAD_FAILED','UPDATE_BUSY','UPDATE_SUBMISSION_PENDING','UPDATE_UNSAVED_RESULT','UPDATE_SAVE_FAILED','UPDATE_PREPARE_TIMEOUT','UPDATE_CLOSE_FAILED','UPDATE_INSTALL_FAILED','ERR_UPDATER_INVALID_SIGNATURE','ERR_CHECKSUM_MISMATCH','ERR_UPDATER_NO_CHECKSUM','ERR_UPDATER_ASSET_NOT_FOUND'].includes(value.code))out.code=value.code;
  if(['direct','system','direct-first'].includes(value.networkMode))out.networkMode=value.networkMode;
  if(typeof value.interactive==='boolean')out.interactive=value.interactive;
  if(typeof value.windowHidden==='boolean')out.windowHidden=value.windowHidden;
  return out;
}
function createUpdateDiagnostics({directory,currentVersion,networkMode,io=fs,now=Date.now,clock=()=>performance.now()}) {
  const file=path.join(directory,'update-diagnostics.json'),sessionId=randomUUID(),started=clock();
  let events=[],omitted=0,writeFailures=0,priorWriteFailures=0,readState='missing',attemptId;
  try {const stat=io.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error();const data=JSON.parse(io.readFileSync(file,'utf8'));events=(Array.isArray(data.events)?data.events:[]).map(project).filter(Boolean).slice(-LIMIT);omitted=Number.isSafeInteger(data.omitted)&&data.omitted>=0?data.omitted:0;priorWriteFailures=Number.isSafeInteger(data.writeFailures)&&data.writeFailures>=0?data.writeFailures:0;readState='loaded';}catch(error){if(error.code!=='ENOENT')readState='unreadable';}
  function persist(){let fd;const temporary=file+'.'+randomUUID()+'.tmp';try{
    try{const stat=io.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error();}catch(error){if(error.code!=='ENOENT')throw error;}
    fd=io.openSync(temporary,'wx',0o600);io.writeFileSync(fd,JSON.stringify({format:'nova-update-diagnostics-v1',omitted,writeFailures:priorWriteFailures+writeFailures,events}));io.fsyncSync(fd);io.closeSync(fd);fd=undefined;io.renameSync(temporary,file);
  }catch{writeFailures++;if(fd!==undefined)try{io.closeSync(fd);}catch{}}finally{try{io.unlinkSync(temporary);}catch{}}}
  function record(event,fields={}){const item=project({...fields,event,sessionId,attemptId,at:new Date(now()).toISOString(),elapsedMs:Math.max(0,Math.round(clock()-started)),currentVersion});if(!item)return;events.push(item);if(events.length>LIMIT){omitted+=events.length-LIMIT;events=events.slice(-LIMIT);}persist();}
  const previous=events.findLast(item=>item.event==='install_requested');
  record('session_started',{networkMode});
  if(previous&&!events.some(item=>item.previousAttemptId===previous.attemptId&&['target_version_started','previous_install_unconfirmed'].includes(item.event)))record(previous.targetVersion===currentVersion?'target_version_started':'previous_install_unconfirmed',{targetVersion:previous.targetVersion,previousAttemptId:previous.attemptId});
  return {record,begin(){attemptId=randomUUID();return attemptId;},error(event,error,fields={}){record(event,{...fields,code:error?.code,errorCategory:classifyError(error),httpStatus:error?.httpStatus||error?.statusCode});},snapshot(){return {format:'nova-update-diagnostics-v1',eventLimit:LIMIT,omitted,health:{readState,writeFailures,priorWriteFailures,persistenceHealthy:writeFailures===0&&readState!=='unreadable'},networkModeScope:'generation_fetch_policy_not_updater_transport_or_vpn_detection',observationBoundary:'parent_exit_ends_installer_observation_version_start_does_not_prove_automatic_install',events:events.map(project)};}};
}
module.exports={createUpdateDiagnostics,project,LIMIT,BASELINE_REASONS};
