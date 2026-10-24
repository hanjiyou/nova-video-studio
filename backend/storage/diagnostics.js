'use strict';
// A positive projection, never a scrubbed copy of SQLite, logs or upstream bodies.
const { DETAILS } = require('./download-errors');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATES = new Set('local_queued submitting submission_unknown remote_queued generating polling_paused remote_completed downloading download_failed completed failed local_cancelled remote_cancelled'.split(' '));
const MODES = new Set(['image.text','image.reference','video.text','video.single_reference','video.dual_reference','video.multi_reference']);
const MODELS = new Set(['gpt-image-2.5-flare','grok-imagine-video-6s','grok-imagine-video-1.5-6s']);
const ERRORS = new Set([...Object.keys(DETAILS),'INPUT_INVALID','CAPABILITY_UNVERIFIED','LOCAL_REQUEST_CONFLICT','SUBMISSION_UNKNOWN','REMOTE_REJECTED','POLL_TRANSIENT','REMOTE_STATUS_UNKNOWN','REMOTE_FAILED','REMOTE_CANCELLED','CREDENTIAL_REQUIRED','CREDENTIAL_UNAVAILABLE']);
const PHASES = new Set(['validation','credential','submit','poll','download','storage','media']);
const pick = (value, values) => values.has(value) ? value : 'other';
const id = value => typeof value === 'string' && UUID.test(value) ? value : null;
const json = value => { try { const parsed=JSON.parse(value);return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } };
const date = value => { const number=typeof value==='string' ? Date.parse(value) : NaN;return Number.isFinite(number) ? new Date(number).toISOString() : null; };
const number = value => typeof value==='number' && Number.isFinite(value) && value>=0 ? value : null;
function parameters(value) {
    const result={};
    if (Number.isInteger(value.seconds) && value.seconds>=1 && value.seconds<=1800) result.seconds=value.seconds;
    if (typeof value.size==='string' && /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/.test(value.size)) result.size=value.size;
    if (['auto','low','medium','high','standard','hd'].includes(value.quality)) result.quality=value.quality;
    return result;
}
function createDiagnostics(db, runtime = {}) {
    return db.transaction(() => {
        const total=db.prepare('SELECT count(*) AS n FROM tasks').get().n;
        const tasks=db.prepare('SELECT * FROM tasks ORDER BY created_at DESC,id DESC LIMIT 1000').all().map(task => {
            const input=json(task.input_snapshot_json || task.request_json),error=json(task.task_error_json);
            const assets=db.prepare('SELECT a.id,a.sha256,a.kind,a.mime_type,a.byte_length,a.width,a.height,a.duration_seconds,a.availability,ta.role,ta.position FROM task_assets ta JOIN assets a ON a.id=ta.asset_id WHERE ta.task_id=? ORDER BY ta.role,ta.position').all(task.id).map(asset=>({assetId:id(asset.id),sha256:/^[a-f0-9]{64}$/i.test(asset.sha256 || '') ? asset.sha256 : null,kind:pick(asset.kind,new Set(['image','video'])),mimeType:pick(asset.mime_type,new Set(['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm'])),byteLength:number(asset.byte_length),width:number(asset.width),height:number(asset.height),durationSeconds:number(asset.duration_seconds),availability:pick(asset.availability,new Set(['available','missing','corrupt'])),role:pick(asset.role,new Set(['input','output'])),position:number(asset.position)}));
            return {localTaskId:id(task.id),localRequestId:id(task.local_request_id),connectionVersionId:id(task.connection_version_id),capabilityVersionId:id(task.capability_version_id),outputDirectoryVersionId:id(task.output_directory_version_id),state:pick(task.status,STATES),mode:pick(input.mode || task.mode,MODES),model:pick(input.model,MODELS),parameters:parameters(input.parameters && typeof input.parameters==='object' ? input.parameters : {}),promptCharacters:typeof input.prompt==='string' ? input.prompt.length : 0,createdAt:date(task.created_at),completedAt:date(task.completed_at),dispatched:Boolean(task.dispatch_started_at),upstreamIdPresent:Boolean(task.upstream_task_id),remoteState:pick(task.remote_state,new Set(['queued','generating','completed','failed','cancelled','unknown'])),requiresContinue:Boolean(task.requires_continue),notBeforeAt:date(task.not_before_at),responseSummary:{remoteIdReceived:Boolean(task.upstream_task_id),httpStatus:Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599 ? error.httpStatus : null},error:Object.keys(error).length ? {code:pick(error.code,ERRORS),phase:pick(error.phase,PHASES),transmission:pick(error.transmission,new Set(['not_dispatched','may_have_reached_upstream','response_received','not_applicable']))} : null,assets,eventCount:db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id=?').get(task.id).n,hidden:Boolean(db.prepare('SELECT 1 FROM workbench_hidden_tasks WHERE task_id=?').get(task.id))};
        });
        return {format:'nova-diagnostics-v1',createdAt:new Date().toISOString(),privacy:{promptText:false,rawResponses:false,credentials:false,urls:false,paths:false,mediaBytes:false,scope:'latest_1000_tasks_including_hidden'},application:{version:/^[0-9]+\.[0-9]+\.[0-9]+$/.test(runtime.version || '') ? runtime.version : 'unknown',electron:process.versions.electron || null,node:process.versions.node,platform:process.platform,arch:process.arch},schemaVersion:db.prepare('SELECT max(version) AS n FROM schema_migrations').get().n,counts:{tasks:total,exported:tasks.length,omitted:Math.max(0,total-tasks.length),pendingSubmissionIntents:db.prepare('SELECT count(*) AS n FROM workbench_submission_intents').get().n},tasks};
    }).deferred();
}
module.exports={createDiagnostics};
