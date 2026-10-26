'use strict';
// Positive projection at collection AND export. Never accept caller text or upstream bodies.
const {randomUUID}=require('node:crypto');
const {CATEGORIES}=require('./diagnostic-error');
const SESSION_ID=randomUUID();
const health=new WeakMap();
const { EXECUTION_PHASES, LOCAL_OUTCOMES } = require('./lifecycle-contract');
const PHASES=new Set(EXECUTION_PHASES),OUTCOMES=new Set(LOCAL_OUTCOMES);
const REASONS=new Set([...Object.keys(require('../storage/download-errors').DETAILS),'SUBMISSION_UNKNOWN','RESPONSE_CREDENTIAL_REDACTED','TASK_TIMED_OUT','TASK_CANCELLED','LEGACY_EXECUTION_ENDED','RESTART_RESULT_UNAVAILABLE','REMOTE_REJECTED','REMOTE_FAILED','REMOTE_CANCELLED','AUTH_REJECTED','CREDENTIAL_REQUIRED','CREDENTIAL_UNAVAILABLE','ADAPTER_UNAVAILABLE','INPUT_INVALID','CAPABILITY_UNVERIFIED','DOWNLOAD_FAILED','DOWNLOAD_EXPIRED','RESULT_NOT_RECOVERABLE','MEDIA_INVALID','MEDIA_DECODE_FAILED','DISK_FULL','FILE_BUSY','POLL_TRANSIENT','RATE_LIMITED','REMOTE_STATUS_UNKNOWN']);
const POINTS=new Set(['queued','phase_changed','response_headers','body_received','result_received','upstream_accepted','remote_state','download_received','terminal','request_started','request_failed','operation_failed','parse_failed','query_response','query_body','download_started','download_headers','download_redirect','download_progress','media_validated','file_saved','recovery_observed','dispatched']);
const REMOTE=new Set(['queued','generating','completed','failed','cancelled','unknown']);
const MAX_EVENTS=96,MAX_COUNT=1000000;
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)).toISOString():null;
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value:null;
const read=value=>{try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}};
function safePoint(value={}){
 const point={};
 if(['cn','com'].includes(value.route))point.route=value.route;
 if(integer(value.routeRevision)!==null&&value.routeRevision>0)point.routeRevision=value.routeRevision;
 if(['newapi.opensosen.cn','newapi.opensosen.com'].includes(value.targetHost))point.targetHost=value.targetHost;
 if(['invalid_json','missing_task_id','invalid_task_id','no_result','unexpected_schema'].includes(value.parseOutcome))point.parseOutcome=value.parseOutcome;
 if(CATEGORIES.has(value.errorCategory))point.errorCategory=value.errorCategory;
 if(['models','submit','poll','download'].includes(value.operation))point.operation=value.operation;
 if(['direct','system','direct-first'].includes(value.networkMode))point.networkMode=value.networkMode;
 for(const key of ['elapsedMs','durationMs','redirectHop'])if(integer(value[key])!==null)point[key]=value[key];
 if(uuid(value.sessionId))point.sessionId=value.sessionId;if(POINTS.has(value.point))point.point=value.point;
 if(PHASES.has(value.phase))point.phase=value.phase;
 if(OUTCOMES.has(value.outcome))point.outcome=value.outcome;
 if(value.reason!==undefined)point.reason=REASONS.has(value.reason)?value.reason:'other';
 if(REMOTE.has(value.remoteState))point.remoteState=value.remoteState;
 if(['inline','url','asset','mixed'].includes(value.sourceKind))point.sourceKind=value.sourceKind;
 if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)point.httpStatus=value.httpStatus;
 if(integer(value.byteLength)!==null)point.byteLength=value.byteLength;
 if(integer(value.candidateCount)!==null)point.candidateCount=Math.min(value.candidateCount,32);
 return point;
}
function safeSummary(value={}){
 const durations=Object.fromEntries(EXECUTION_PHASES.map(phase=>[phase,integer(value.durations?.[phase])]));
 return {observedElapsedMs:integer(value.observedElapsedMs),elapsedUnknown:value.elapsedUnknown===true,unknownDurationPhases:Array.isArray(value.unknownDurationPhases)?[...new Set(value.unknownDurationPhases.filter(phase=>PHASES.has(phase)))]:[],durationClock:'monotonic_observations',attemptId:uuid(value.attemptId),scope:value.scope==='download'?'download':'generation',startedAt:validDate(value.startedAt),finishedAt:validDate(value.finishedAt),phase:PHASES.has(value.phase)?value.phase:null,phaseStartedAt:validDate(value.phaseStartedAt),outcome:OUTCOMES.has(value.outcome)?value.outcome:null,reason:value.reason==null?null:REASONS.has(value.reason)?value.reason:'other',durations,queryCount:integer(value.queryCount),queryFailureCount:integer(value.queryFailureCount),lastQueryAt:validDate(value.lastQueryAt),lastQueryFailure:value.lastQueryFailure==null?null:REASONS.has(value.lastQueryFailure)?value.lastQueryFailure:'other',httpStatus:Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?value.httpStatus:null,responseBytes:integer(value.responseBytes),downloadBytes:integer(value.downloadBytes),sourceKind:['inline','url','asset','mixed'].includes(value.sourceKind)?value.sourceKind:null,omittedEvents:integer(value.omittedEvents)??0};
}
function createDiagnosticTimeline({db,now=Date.now}){
 const iso=()=>new Date(now()).toISOString(),contexts=new WeakMap();
 function summary(taskId,ctx,mutate){
  const scope=ctx?.downloadAttempt?'download':'generation',type='execution_summary_'+scope;
  const saved=db.prepare('SELECT id,payload_json FROM task_events WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 1').get(taskId,type);
  let value=saved?read(saved.payload_json):{};
  const attemptId=ctx?.token||null,sameSavedAttempt=Boolean(saved&&value.attemptId===attemptId);
  if(!saved||(ctx&&value.attemptId!==attemptId))value={attemptId,scope,startedAt:ctx?(ctx.downloadAttempt?.started_at||db.prepare('SELECT dispatch_started_at FROM tasks WHERE id=?').get(taskId)?.dispatch_started_at||iso()):null,durations:{},queryCount:ctx?0:null,queryFailureCount:ctx?0:null,omittedEvents:0};
  if(ctx&&!contexts.has(ctx)){
   if(sameSavedAttempt){value.elapsedUnknown=true;value.unknownDurationPhases=[...new Set([...(value.unknownDurationPhases||[]),...(PHASES.has(value.phase)?[value.phase]:[])])];}
   contexts.set(ctx,{phase:null,started:null});
  }
  if(ctx?.elapsedMs){const measured=ctx.elapsedMs();if(integer(measured)!==null)value.observedElapsedMs=measured;}
  mutate(value);const payload=JSON.stringify(safeSummary(value));
  if(saved)db.prepare('UPDATE task_events SET payload_json=? WHERE id=?').run(payload,saved.id);
  else db.prepare('INSERT INTO task_events(task_id,type,payload_json,created_at) VALUES(?,?,?,?)').run(taskId,type,payload,iso());
 }
 function record(taskId,point,payload={},ctx){
  if(!POINTS.has(point))return;
  if(point==='recovery_observed'&&db.prepare("SELECT payload_json FROM task_events WHERE task_id=? AND type='execution_diagnostic'").all(taskId).some(row=>{const value=read(row.payload_json);return value.point===point&&value.sessionId===SESSION_ID;}))return;
  const safe={...safePoint({...payload,point,sessionId:SESSION_ID,elapsedMs:ctx?.elapsedMs?.(),networkMode:process.env.NOVA_NETWORK_MODE||'direct'}),attemptId:uuid(ctx?.token),scope:ctx?.downloadAttempt?'download':'generation'};
  db.prepare('INSERT INTO task_events(task_id,type,payload_json,created_at) VALUES(?,?,?,?)').run(taskId,'execution_diagnostic',JSON.stringify(safe),iso());
  // Preserve early request boundaries plus a rolling tail; summaries keep complete phase totals.
  const rows=db.prepare("SELECT id FROM task_events WHERE task_id=? AND type='execution_diagnostic' ORDER BY id").all(taskId);
  if(rows.length>MAX_EVENTS){const removed=rows.slice(16,16+rows.length-MAX_EVENTS);for(const item of removed)db.prepare('DELETE FROM task_events WHERE id=?').run(item.id);summary(taskId,ctx,value=>{value.omittedEvents=(value.omittedEvents||0)+removed.length;});}
 }
 function closePhase(value,ctx){
  if(!PHASES.has(value.phase))return;
  const observation=ctx&&contexts.get(ctx),elapsed=ctx?.elapsedMs?.();
  if(observation?.phase===value.phase&&integer(observation.started)!==null&&integer(elapsed)!==null&&elapsed>=observation.started&&!value.unknownDurationPhases?.includes(value.phase))value.durations[value.phase]=(integer(value.durations[value.phase])??0)+elapsed-observation.started;
  else{value.durations[value.phase]=null;value.unknownDurationPhases=[...new Set([...(value.unknownDurationPhases||[]),value.phase])];}
 }
 function phase(taskId,value,ctx){if(!PHASES.has(value))return;let changed=false;summary(taskId,ctx,item=>{if(item.phase!==value){closePhase(item,ctx);item.phase=value;item.phaseStartedAt=iso();changed=true;}if(ctx){const observation=contexts.get(ctx);if(changed||observation.phase===null)contexts.set(ctx,{phase:value,started:ctx.elapsedMs?.()??null});}});if(changed)record(taskId,'phase_changed',{phase:value},ctx);}
 function observe(taskId,point,payload,ctx){
  if(!POINTS.has(point))return;
  if(point==='recovery_observed'&&db.prepare("SELECT payload_json FROM task_events WHERE task_id=? AND type='execution_diagnostic'").all(taskId).some(row=>{const value=read(row.payload_json);return value.point===point&&value.sessionId===SESSION_ID;}))return;
  const safe=safePoint({...payload,point});
  summary(taskId,ctx,item=>{if(safe.httpStatus!==undefined)item.httpStatus=safe.httpStatus;if(point==='body_received'&&safe.byteLength!==undefined)item.responseBytes=(integer(item.responseBytes)??0)+safe.byteLength;if(point==='download_received'&&safe.byteLength!==undefined)item.downloadBytes=(integer(item.downloadBytes)??0)+safe.byteLength;if(safe.sourceKind&&!item.sourceKind)item.sourceKind=safe.sourceKind;});
  record(taskId,point,safe,ctx);
 }
 function query(taskId,ctx,error){summary(taskId,ctx,value=>{if(error){value.queryFailureCount=Math.min(MAX_COUNT,(value.queryFailureCount||0)+1);value.lastQueryFailure=REASONS.has(error.code)?error.code:error.httpStatus===429?'RATE_LIMITED':'POLL_TRANSIENT';}else{value.queryCount=Math.min(MAX_COUNT,(value.queryCount||0)+1);value.lastQueryAt=iso();}});}
 function end(taskId,outcome,reason,ctx){if(!OUTCOMES.has(outcome))return;summary(taskId,ctx,value=>{if(!value.finishedAt){closePhase(value,ctx);value.finishedAt=iso();value.outcome=outcome;if(reason)value.reason=REASONS.has(reason)?reason:'other';}});record(taskId,'terminal',{outcome,...(reason?{reason}:{})},ctx);}
 // Diagnostic storage failure must not fail a generation or mask its original error.
 return Object.fromEntries(Object.entries({record,phase,observe,query,end}).map(([name,fn])=>[name,(...args)=>{try{return fn(...args);}catch{health.set(db,(health.get(db)||0)+1);}}]));
}
function safeDownloadAttempt(row,number,lifecycleVersion){
 const value=read(row.progress_json),progress={};
 for(const key of ['fileIndex','fileCount','receivedBytes','totalBytes','overallReceivedBytes','overallTotalBytes','reusedBytes','completedBytes','savedFileCount','elapsedMs','transferNumber','stallCount'])progress[key]=integer(value[key]);
 const transportRoute=read(row.transport_route_json);
 return {transportRoute:['cn','com'].includes(transportRoute.route)&&integer(transportRoute.revision)>0?{route:transportRoute.route,revision:transportRoute.revision}:null,attemptId:uuid(row.id),attemptNumber:number,retryCount:Math.max(0,number-(lifecycleVersion===2?1:0)),queuedAt:validDate(row.queued_at),startedAt:validDate(row.started_at),deadlineAt:validDate(row.deadline_at),finishedAt:validDate(row.finished_at),timeoutSeconds:integer(row.timeout_seconds),budgetSource:lifecycleVersion===2?'independent_download':'historical_download_attempt',outcome:OUTCOMES.has(row.outcome)?row.outcome:null,reason:REASONS.has(row.error_code)?row.error_code:null,httpStatus:Number.isInteger(row.http_status)&&row.http_status>=100&&row.http_status<=599?row.http_status:null,phase:['waiting','refreshing','downloading','validating','saving','completed','failed','cancelled'].includes(value.phase)?value.phase:null,lastByteAt:validDate(value.lastByteAt),lastStalledAt:validDate(value.lastStalledAt),bytesPerSecond:row.outcome?0:integer(value.bytesPerSecond),stalled:!row.outcome&&value.stalled===true,...progress};
}
function timelineFor(db,task,at){
 const rows=db.prepare("SELECT type,payload_json,created_at FROM task_events WHERE task_id=? AND type IN ('execution_diagnostic','execution_summary_generation','execution_summary_download') ORDER BY id").all(task.id);
 const summaries=rows.filter(row=>row.type!=='execution_diagnostic').map(row=>safeSummary(read(row.payload_json)));
 const generation=summaries.find(item=>item.scope==='generation')||null;
 const duration=(start,end)=>validDate(start)&&validDate(end)&&Date.parse(end)>=Date.parse(start)?Date.parse(end)-Date.parse(start):null;
 const attempts=db.prepare('SELECT * FROM task_download_attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 10').all(task.id),attemptCount=db.prepare('SELECT count(*) AS n FROM task_download_attempts WHERE task_id=?').get(task.id).n;
 const downloads=attempts.map((row,index)=>safeDownloadAttempt(row,attemptCount-index,task.lifecycle_version));
 const ended=Boolean(task.local_outcome)||['completed','failed','download_failed','timed_out','local_cancelled','remote_cancelled'].includes(task.status),finished=task.local_finished_at||task.completed_at;
 return {downloadAttempts:downloads,downloadAttemptCount:attemptCount,omittedDownloadAttempts:Math.max(0,attemptCount-10),systemProxyTakeover:'unknown',networkModeMeaning:'application_request_policy_not_system_proxy_detection',diagnosticWriteFailuresThisSession:health.get(db)||0,queueClock:'wall_timestamp_estimate',queueMs:duration(task.created_at,task.dispatch_started_at||finished||(ended?null:at)),executionMs:generation?.finishedAt&&!generation.elapsedUnknown?generation.observedElapsedMs:null,timeoutSeconds:integer(task.execution_timeout_seconds),deadlineAt:validDate(task.execution_deadline_at),generation,latestDownload:downloads[0]?{...(summaries.find(item=>item.scope==='download'&&item.attemptId===downloads[0].attemptId)||{}),...downloads[0],downloadBytes:downloads[0].overallReceivedBytes}:summaries.find(item=>item.scope==='download')||null,timeline:rows.filter(row=>row.type==='execution_diagnostic').slice(-MAX_EVENTS).map(row=>{const value=read(row.payload_json);return {at:validDate(row.created_at),...safePoint(value),attemptId:uuid(value.attemptId),scope:value.scope==='download'?'download':'generation'};}),eventLimit:MAX_EVENTS,limited:summaries.some(item=>item.omittedEvents>0),httpWaitMeaning:'request_upload_network_and_remote_processing_unknown'};
}
module.exports={createDiagnosticTimeline,timelineFor,safePoint,safeSummary,MAX_EVENTS};
