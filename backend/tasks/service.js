'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { UUID, fail } = require('../storage/store');
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) throw fail('INVALID_ID'); return value; };
const routing = require('../connections/route-policy');
const { containsCredential } = require('../connections/redaction');
const { isQueryableUpstreamTaskId } = require('../plugin-runtime/upstream-id');
const { DETAILS, failure: downloadFailure } = require('../storage/download-errors');
const { executionSnapshot, mediaKind, localOutcome, remoteOutcome } = require('./lifecycle-contract');
const {createDownloadProgress}=require('../storage/download-progress');
const { createExecutionRuntime } = require('./execution-runtime');
const {classifyError}=require('./diagnostic-error');
const { createDiagnosticTimeline } = require('./diagnostic-timeline');
const TERMINAL = new Set(['completed', 'failed', 'download_failed', 'local_cancelled', 'remote_cancelled', 'timed_out']);
const REMOTE_ACTIVE = new Set(['remote_queued', 'generating']);
const RESERVING = new Set(['submitting', 'submission_unknown', 'remote_queued', 'generating', 'polling_paused']);
const ACTIVE = new Set([...RESERVING, 'remote_completed', 'downloading']);
const STATES = new Set(['local_queued', ...RESERVING, 'remote_completed', 'downloading', 'download_failed', ...TERMINAL]);
const DEFAULT_POLICY = Object.freeze({ intervalMs: 20000, maxDelayMs: 120000, maxRetries: 5, budgetMs: 600000 });
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, sort(value[k])]));
    return value;
}
function retryAfter(value, now) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim();
    if (/^\d+(\.\d+)?$/.test(raw)) return Number.isFinite(Number(raw)*1000) ? Math.ceil(Number(raw)*1000) : Number.MAX_SAFE_INTEGER;
    const date = Date.parse(raw);
    return Number.isFinite(date) && /[a-z]/i.test(raw) ? Math.max(0, date - now) : null;
}
const MESSAGES = {
    SUBMISSION_UNKNOWN: '创建结果不明，请核对上游记录；不会自动重新创建。',
    REMOTE_REJECTED: '上游明确拒绝创建，请检查输入。',
    MODEL_UNAVAILABLE: '上游明确报告当前型号不存在、已停用或不可用，请刷新列表并选择型号。',
    AUTH_REJECTED: '连接鉴权被拒绝，已暂停查询并保留原任务。',
    CREDENTIAL_REQUIRED: '原连接版本凭据已清除，任务已暂停。',
    CREDENTIAL_UNAVAILABLE: '原连接版本凭据不可用，任务已暂停。',
    POLL_TRANSIENT: '查询暂不可用，已保留上游任务。',
    RATE_LIMITED: '查询受限，等待允许时间后继续。',
    REMOTE_STATUS_UNKNOWN: '上游状态无法识别，已暂停查询。',
    REMOTE_FAILED: '上游明确报告生成失败。',
    REMOTE_CANCELLED: '上游明确报告任务已取消。',
    DOWNLOAD_FAILED: '结果尚未保存为经过验证的本地文件。',
    DOWNLOAD_EXPIRED: '结果地址不可持久保存，需要从原任务刷新。',
    INPUT_INVALID: '任务预检失败，尚未派发。',
    CAPABILITY_UNVERIFIED: '当前组合缺少成功协议证据，尚未派发。',
    ADAPTER_UNAVAILABLE: '原适配器版本不可用，任务已暂停。',
    TASK_TIMED_OUT: '已达到本地最长等待时间；远端结果可能仍需核对，不会自动重新生成。',
    TASK_CANCELLED: '已停止本地等待；远端可能仍在生成或计费。',
    LEGACY_EXECUTION_ENDED: '升级已结束旧任务的本地等待；远端结果待核对，不会自动提交或查询。',
    RESTART_RESULT_UNAVAILABLE: '重启后无法安全继续原请求，已结束本地等待；远端结果待核对。',
};
function errorDto(code, phase, task, extra = {}) {
    return { code, phase, message: DETAILS[code]?.[1] || MESSAGES[code] || '任务已暂停，请检查详情。', retryAction: ({
        SUBMISSION_UNKNOWN: 'reconcile_submission', MODEL_UNAVAILABLE: 'edit_input', REMOTE_REJECTED: 'edit_input', INPUT_INVALID: 'edit_input', CAPABILITY_UNVERIFIED: 'edit_input',
        AUTH_REJECTED: 'reauthenticate', CREDENTIAL_REQUIRED: 'reauthenticate', CREDENTIAL_UNAVAILABLE: 'reauthenticate',
        POLL_TRANSIENT: 'retry_poll', RATE_LIMITED: 'retry_poll', REMOTE_STATUS_UNKNOWN: 'retry_poll',
        DOWNLOAD_FAILED: 'retry_download', DOWNLOAD_EXPIRED: 'retry_download',
    })[code] || (DETAILS[code] ? 'retry_download' : 'none'), transmission: phase === 'submit' ? 'may_have_reached_upstream' : 'not_applicable',
    localTaskId: task.id, ...(task.upstream_task_id ? { upstreamTaskId: task.upstream_task_id } : {}), ...extra };
}
/** Desktop-only durable orchestration. Adapters perform exactly one submit or one GET.
 * Download workers are injected by T08; without one, candidates remain remote_completed.
 */
function createTaskService({ db, store, connections, resolveAdapter, onChange = () => {}, now = Date.now, monotonic, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, policy = {}, downloadWorker = null }) {
    const rules = { ...DEFAULT_POLICY, ...policy }, timers = new Map(), inFlight = new Map(), ephemeralSources = new Map(), starting = new Set();
    let closed = false, updatePaused = false, pumping = false, downloadsRunning = 0, schedulerError = null;
    function stopScheduler() {
        schedulerError = 'STORAGE_OPERATION_FAILED'; closed = true; for (const timer of timers.values()) clearTimer(timer); timers.clear(); runtime.close(); for(const entry of inFlight.values())entry.controller.abort();
    }
    function background(promise) { promise.catch(error => {
        if (error?.code === 'TASK_EXECUTION_ENDED' || error?.name === 'AbortError' || error?.code === 'TASK_ACTION_INVALID') return;
        stopScheduler();
    }); }
    const iso = ms => new Date(Math.min(8640000000000000, ms ?? now())).toISOString();
    const row = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(uuid(id));
    const telemetry = createDiagnosticTimeline({db,now});
    const event = (id, type, payload = {}) => store.appendTaskEvent(id, type, payload);
    const emit = id => { db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(id); queueMicrotask(() => { if (!closed) onChange(id); }); };
    const kind = task => task.execution_media_kind || mediaKind(JSON.parse(task.input_snapshot_json || '{}').mode || task.mode);
    const settings = () => store.getSetting('taskExecution').value;
    const retryJob = id => db.prepare("SELECT * FROM task_download_attempts WHERE task_id=? AND outcome IS NULL ORDER BY rowid DESC LIMIT 1").get(id);
    function reservationCounts() {
        const counts={image:0,video:0},candidates=new Map(db.prepare("SELECT t.*,EXISTS(SELECT 1 FROM task_download_attempts d WHERE d.task_id=t.id AND d.outcome IS NULL) AS retry_active FROM tasks t WHERE (t.local_outcome IS NULL AND t.status IN ('submitting','submission_unknown','remote_queued','generating','polling_paused','remote_completed','downloading')) OR EXISTS(SELECT 1 FROM task_download_attempts d WHERE d.task_id=t.id AND d.outcome IS NULL)").all().map(task=>[task.id,task]));
        for(const id of starting)if(!candidates.has(id))candidates.set(id,row(id));
        for(const task of candidates.values())if(task&&(task.retry_active||!localOutcome(task)&&(starting.has(task.id)||ACTIVE.has(task.status)&&(task.dispatch_started_at||task.upstream_task_id))))counts[kind(task)]++;
        return counts;
    }
    const runtime = createExecutionRuntime({ now, monotonic, setTimer, clearTimer, onError:stopScheduler,
        current(id, ctx) { const task = row(id); return !closed && task && (ctx.downloadAttempt ? retryJob(id)?.id === ctx.token : !localOutcome(task) && !task.generation_outcome && task.execution_attempt_id === ctx.token); },
        expire(id, ctx) { finishLocal(id, 'timed_out', ctx.downloadAttempt ? 'DOWNLOAD_TIMEOUT' : 'TASK_TIMED_OUT', ctx); },
        phase(id, value, ctx) { telemetry.phase(id,value,ctx); const task = row(id); if (task.execution_phase !== value) { db.prepare('UPDATE tasks SET execution_phase=?,execution_phase_started_at=? WHERE id=?').run(value, iso(), id); emit(id); } },
    });
    function finishLocal(id, outcome, code, ctx = runtime.active.get(id)) {
        const task = row(id); if (!task) return false;
        const waiting = !ctx && retryJob(id);
        if (waiting) ctx = { token:waiting.id, downloadAttempt:waiting };
        if(ctx)ctx.endedOutcome=outcome;
        if (ctx?.downloadAttempt) {
            const changed = db.prepare('UPDATE task_download_attempts SET outcome=?,finished_at=? WHERE id=? AND outcome IS NULL').run(outcome, iso(), ctx.token).changes;
            if (!changed) return false;
            db.prepare('UPDATE task_download_attempts SET error_code=? WHERE id=?').run(code,ctx.token);
            db.prepare("UPDATE task_downloads SET state='failed',updated_at=? WHERE task_id=?").run(iso(), id);
            const error = errorDto(code, task.execution_phase || 'download', task);
            db.prepare("UPDATE tasks SET status='download_failed',next_poll_at=NULL,task_error_json=?,error=?,local_outcome=COALESCE(local_outcome,?),local_finished_at=COALESCE(local_finished_at,?) WHERE id=?").run(JSON.stringify(error),error.message,outcome,iso(),id);
            persistFinalDownloadProgress(id,ctx,outcome==='cancelled'?'cancelled':'failed');
            event(id, 'download_attempt_ended', { outcome, code }); telemetry.end(id,outcome,code,ctx); emit(id);
        } else {
            if (localOutcome(task)) return false;
            const error = errorDto(code, task.execution_phase || 'submit', task, { transmission: task.dispatch_started_at ? 'may_have_reached_upstream' : 'not_dispatched' });
            db.transaction(() => {
                const changed = db.prepare('UPDATE tasks SET status=?,local_outcome=?,local_finished_at=?,completed_at=?,remote_outcome=?,task_error_json=?,error=?,next_poll_at=NULL,requires_continue=0 WHERE id=? AND local_outcome IS NULL').run(outcome === 'cancelled' ? 'local_cancelled' : outcome === 'timed_out' ? 'timed_out' : 'failed', outcome, iso(), iso(), remoteOutcome(task), JSON.stringify(error), error.message, id).changes;
                if (changed && task.lifecycle_version===2 && !task.generation_outcome) db.prepare('UPDATE tasks SET generation_outcome=?,generation_finished_at=? WHERE id=? AND generation_outcome IS NULL').run(outcome,iso(),id);
                if (changed) { event(id, 'local_execution_ended', { outcome, code, phase: task.execution_phase }); telemetry.end(id,outcome,code,ctx); }
                db.prepare("UPDATE task_downloads SET state='failed',updated_at=? WHERE task_id=? AND state IN ('waiting','running')").run(iso(), id);
            }).immediate();
            emit(id);
        }
        cancelTimer(id); runtime.finish(id); inFlight.get(id)?.controller.abort(); if (!task.result_sources_json) ephemeralSources.delete(id); queueMicrotask(() => { background(pump()); background(drainDownloads()); }); return true;
    }
    function persistFinalDownloadProgress(id,ctx,phase) {
        if(!ctx?.downloadAttempt)return;
        const persisted=db.prepare('SELECT * FROM task_download_attempts WHERE id=?').get(ctx.token);
        if(ctx.finalDownloadPersisted&&persisted?.outcome&&persisted.progress_json===JSON.stringify(ctx.finalDownloadSnapshot))return;
        const tracker=ctx.options?.progressTracker;
        if(!ctx.finalDownloadSnapshot&&tracker){
            const value=tracker.snapshot(),attempt=ctx.downloadAttempt,task=row(id);
            ctx.finalDownloadReason=phase==='completed'?null:JSON.parse(task.task_error_json||'null')?.code;
            const count=db.prepare('SELECT count(*) AS n FROM task_download_attempts WHERE task_id=? AND rowid<=(SELECT rowid FROM task_download_attempts WHERE id=?)').get(id,ctx.token).n;
            ctx.finalDownloadSnapshot={...value,phase,bytesPerSecond:0,stalled:false,elapsedMs:ctx.elapsedMs(),attemptId:ctx.token,attemptNumber:count,retryCount:count-(task.lifecycle_version===2?1:0),startedAt:attempt.started_at,deadlineAt:attempt.deadline_at,timeoutSeconds:attempt.timeout_seconds};
        }
        tracker?.close();
        if(ctx.finalDownloadSnapshot)db.prepare('UPDATE task_download_attempts SET progress_json=? WHERE id=?').run(JSON.stringify(ctx.finalDownloadSnapshot),ctx.token);
        store.setLiveDownloadProgress(ctx.token,null);
        if(ctx.finalDownloadSnapshot){
            const attempt=db.prepare('SELECT * FROM task_download_attempts WHERE id=?').get(ctx.token);
            const code=attempt.outcome==='completed'?null:ctx.finalDownloadReason;
            db.prepare('UPDATE task_download_attempts SET error_code=COALESCE(error_code,?) WHERE id=?').run(DETAILS[code]||code==='TASK_CANCELLED'?code:null,ctx.token);
            ctx.finalDownloadPersisted=true;
            if(db.prepare('SELECT id FROM task_download_attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(id)?.id===ctx.token){telemetry.end(id,attempt.outcome||'failed',code,ctx);emit(id);}
        }
    }
    function context(task) { const ctx = runtime.active.get(task.id) || runtime.start(task, retryJob(task.id)); ctx.options.diagnostic = (point,payload) => { ctx.checkpoint(); if(ctx.downloadAttempt&&Number.isInteger(payload?.httpStatus)&&payload.httpStatus>=100&&payload.httpStatus<=599)db.prepare('UPDATE task_download_attempts SET http_status=? WHERE id=? AND outcome IS NULL').run(payload.httpStatus,ctx.token); telemetry.observe(task.id,point,payload,ctx); }; ctx.checkpoint(); return ctx; }
    function wake() { if (!closed) queueMicrotask(() => { background(pump()); background(drainDownloads()); }); }
    function track(key, task, run) {
        if (inFlight.has(key)) return inFlight.get(key).promise;
        // Install the physical IO gate before the operation can yield or call back.
        const entry = { kind: kind(task), promise: null, controller:new AbortController() }; inFlight.set(key, entry);
        entry.promise = Promise.resolve().then(()=>run(entry.controller.signal)).finally(() => { inFlight.delete(key); starting.delete(task.id); wake(); });
        return entry.promise;
    }
    function physicalCount(media) { return [...inFlight.values()].filter(entry => entry.kind === media).length; }
    function update(id, state, fields = {}, type = 'task_transition', payload = {}) {
        if (!STATES.has(state)) throw fail('TASK_STATE_INVALID');
        db.transaction(() => {
            const before = row(id);
            if (!before) throw fail('TASK_NOT_FOUND', '找不到任务。', 404);
            const downloadRetry = ['missing_result_download_requested','download_retry_requested'].includes(type) || Boolean(retryJob(id));
            if (localOutcome(before) && state !== before.status && !downloadRetry) throw fail('TASK_EXECUTION_ENDED');
            const allowed = ['upstream_task_id', 'dispatch_started_at', 'remote_state', 'raw_status', 'remote_progress', 'pause_reason', 'not_before_at', 'next_poll_at', 'poll_attempts', 'poll_budget_started_at', 'task_error_json', 'error', 'requires_continue', 'result_sources_json', 'completed_at', 'execution_attempt_id', 'execution_deadline_at', 'local_outcome', 'local_finished_at', 'remote_outcome', 'execution_phase', 'execution_phase_started_at', 'generation_outcome', 'generation_finished_at'];
            if (Object.keys(fields).some(key => !allowed.includes(key))) throw fail('TASK_STATE_INVALID');
            if (TERMINAL.has(state) && before.lifecycle_version === 2 && !before.generation_outcome && state !== 'download_failed') Object.assign(fields, {generation_outcome:localOutcome({status:state}),generation_finished_at:iso()});
            if (TERMINAL.has(state) && !localOutcome(before)) Object.assign(fields, { local_outcome: localOutcome({ status: state }), local_finished_at: iso(), remote_outcome: remoteOutcome({ ...before, ...fields, status: state }) });
            db.prepare('UPDATE tasks SET status=?' + Object.keys(fields).map(key => ',' + key + '=?').join('') + ' WHERE id=?').run(state, ...Object.values(fields), id);
            if (type !== 'task_transition' || before.status !== state) event(id, type, { previous: before.status, next: state, ...payload });
            const ctx = runtime.active.get(id);
            if (fields.remote_state && fields.remote_state !== before.remote_state) telemetry.observe(id,'remote_state',{remoteState:fields.remote_state},ctx);
            if (type === 'upstream_accepted') telemetry.observe(id,'upstream_accepted',{},ctx);
            if (TERMINAL.has(state) && (!localOutcome(before) || retryJob(id))) {
                let reason; try { reason = JSON.parse(fields.task_error_json || 'null')?.code; } catch { /* No raw error in diagnostics. */ }
                telemetry.end(id,localOutcome({status:state}),reason,ctx);
            }
        }).immediate();
        if (TERMINAL.has(state)) { cancelTimer(id); if (!retryJob(id)) runtime.finish(id); wake(); }
        emit(id);
    }
    function setError(id, state, code, phase, fields = {}, extra = {}) {
        const task = row(id), error = errorDto(code, phase, task, extra);
        if (TERMINAL.has(state) && state!=='download_failed' && !localOutcome(task) && !fields.completed_at) fields.completed_at=iso();
        update(id, state, { task_error_json: JSON.stringify(error), error: error.message, ...fields }, code.startsWith('CREDENTIAL_') ? 'credential_access_paused' : 'task_error', { code, phase });
    }
    function cancelTimer(id) { const timer = timers.get(id); if (timer) clearTimer(timer); timers.delete(id); }
    function schedule(id, when) {
        cancelTimer(id);
        if (closed || updatePaused) return;
        const delay = Math.max(0, when - now());
        const timer = setTimer(() => { timers.delete(id); background(poll(id)); }, Math.min(delay, 2147483647));
        timer.unref?.(); timers.set(id, timer);
    }
    function adapter(task) {
        const result = resolveAdapter(task, JSON.parse(task.input_snapshot_json || '{}'), JSON.parse(task.request_json));
        if (!result || result.id !== task.adapter_id || result.version !== task.adapter_version) throw fail('ADAPTER_UNAVAILABLE');
        return result;
    }
    function snapshotFor(input) {
        const snapshot = JSON.parse(canonical(input));
        snapshot.localRequestId = uuid(snapshot.localRequestId).toLowerCase();
        if (snapshot.connectionVersionId) snapshot.connectionVersionId = uuid(snapshot.connectionVersionId).toLowerCase();
        return snapshot;
    }
    function findDuplicate(snapshot) {
        const checked = snapshotFor(snapshot);
        const existing = db.prepare('SELECT * FROM tasks WHERE local_request_id=?').get(checked.localRequestId);
        if (!existing) return null;
        const saved = JSON.parse(existing.input_snapshot_json);
        // Transport is server-owned and does not change the user's generation intent.
        delete saved.transportRoute; delete checked.transportRoute;
        if (!checked.outputDirectoryVersionId && !checked.outputRootRef) {
            if(saved.outputDirectoryVersionId)checked.outputDirectoryVersionId=saved.outputDirectoryVersionId;
            if(saved.outputRootRef)checked.outputRootRef=saved.outputRootRef;
        }
        // A raw first submission may omit server-frozen group metadata. Only an
        // omitted default group can be replayed as default; custom intent stays explicit.
        if (saved.groupId && !checked.groupId && saved.groupId === require('../storage/groups').DEFAULT_GROUP) checked.groupId = saved.groupId;
        if (checked.groupId === saved.groupId) {
            if (saved.groupName && checked.groupName === undefined) checked.groupName = saved.groupName;
            if (saved.groupDirectoryVersionId && !checked.groupDirectoryVersionId) checked.groupDirectoryVersionId = saved.groupDirectoryVersionId;
        }
        if (canonical(saved) !== canonical(checked)) throw fail('LOCAL_REQUEST_CONFLICT', '同一本地请求标识对应不同任务输入。', 409);
        return existing.id;
    }
    function enqueue({ snapshot: input, request, mode }) {
        if (closed || updatePaused) throw fail('SERVER_NOT_ACCEPTING_TASKS', '服务正在关闭或准备更新。', 503);
        if(Object.hasOwn(input,'transportRoute'))throw fail('INPUT_INVALID');
        let snapshot = snapshotFor(input); const duplicate = findDuplicate(snapshot);
        if (duplicate) return duplicate;
        snapshot = store.freezeOutputDirectory(snapshot);
        // A controlled preflight can establish not_dispatched. No key is kept in the record.
        connections.getAuth(snapshot.connectionVersionId);
        const transportRoute=connections.getTransportRoute?.(snapshot.connectionVersionId)||null;
        if(transportRoute)snapshot.transportRoute=transportRoute;
        const id = randomUUID(), execution = executionSnapshot(snapshot.mode, store.getSetting('taskExecution').value);
        db.transaction(() => {
            db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,execution_media_kind,execution_timeout_seconds,lifecycle_version) VALUES(?,?,?,?,?,?,?,2)').run(id, 'local_queued', mode, JSON.stringify(request), iso(), execution.mediaKind, execution.timeoutSeconds);
            if(transportRoute)db.prepare('UPDATE tasks SET transport_route_json=? WHERE id=?').run(JSON.stringify(transportRoute),id);
            store.setTaskSnapshot(id, snapshot);
            event(id, 'task_enqueued', { contractVersion: 1 }); telemetry.record(id,'queued');
        }).immediate();
        emit(id); queueMicrotask(() => background(pump())); return id;
    }
    function sanitizeRaw(value, key) {
        if (value == null) return null;
        const raw = String(value);
        // No URLs, encoded key echoes, or arbitrary response bodies in public state/events.
        if (containsCredential(raw, key) || /https?:|authorization|bearer\s|data:|[\r\n]/i.test(raw)) return '[hidden]';
        return raw.slice(0, 128);
    }
    function candidates(task, result, key, ctx) {
        if (!Array.isArray(result) || result.length === 0 || result.length > 32) throw fail('REMOTE_STATUS_UNKNOWN');
        const transient=[];
        const saved=result.map(source => {
            ctx?.checkpoint();
            if (source.kind === 'asset') { store.readAsset(source.assetId); return { kind: 'asset', assetId: source.assetId }; }
            if (source.kind === 'inline') {
                const asset = store.importBuffer(source.bytes, { mimeType: source.mimeType, sourceKind: 'generated' });
                ctx?.checkpoint();
                return { kind: 'asset', assetId: asset.assetId };
            }
            if(typeof source.url!=='string'||source.url.length>8192)throw fail('DOWNLOAD_EXPIRED');
            const url = new URL(source.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || containsCredential(url.toString(), key)) throw Object.assign(fail('DOWNLOAD_EXPIRED'), { credentialRedacted: containsCredential(url.toString(), key) });
            // Signed addresses are handed directly to the worker in memory. A durable marker
            // records the limitation without persisting any query/token or temporary path.
            if (url.search) { transient.push({kind:'url',mediaKind:source.mediaKind || 'image',authScope:source.authScope==='connection'?'connection':'none',url:url.toString() }); return { kind:'ephemeral', mediaKind:source.mediaKind || 'image' }; }
            return { kind: 'url', url: url.toString(), authScope: source.authScope === 'connection' ? 'connection' : 'none', mediaKind: source.mediaKind || 'image' };
        });
        if(transient.length)ephemeralSources.set(task.id,result.map((source,index)=>saved[index].kind==='ephemeral'?transient.shift():saved[index]));
        else ephemeralSources.delete(task.id);
        const full=ephemeralSources.get(task.id)||saved;
        const outputSetId=randomUUID();
        for(const [position,source] of full.entries()){source.outputSetId=outputSetId;source.sourceKey=createHash('sha256').update(canonical({position,source})).digest('hex');}
        for(let i=0;i<saved.length;i++)saved[i].sourceKey=full[i].sourceKey;
        return saved;
    }
    function remoteCompleted(id, result, key, rawStatus = null, ctx = context(row(id))) {
        ctx.checkpoint();
        const kinds = Array.isArray(result) ? [...new Set(result.map(source => source?.kind))] : [];
        telemetry.observe(id,'result_received',{sourceKind:kinds.length===1?kinds[0]:'mixed',candidateCount:Array.isArray(result)?result.length:undefined},ctx);
        let sources;
        try { sources = candidates(row(id), result, key, ctx); ctx.checkpoint(); }
        catch (error) { if (error.code === 'TASK_EXECUTION_ENDED') return; setError(id, 'download_failed', error.code === 'DOWNLOAD_EXPIRED' ? 'DOWNLOAD_EXPIRED' : 'DOWNLOAD_FAILED', 'download', { remote_state: 'completed', pause_reason: null, next_poll_at: null }, error.credentialRedacted ? { message: '上游资源地址包含连接凭据，已停止下载。' } : {}); background(pump()); return; }
        db.transaction(() => {
            ctx.checkpoint();
            update(id, 'remote_completed', { result_sources_json: JSON.stringify(sources), remote_state: 'completed', raw_status: rawStatus, remote_progress: 100, task_error_json: null, error: null, next_poll_at: null, pause_reason: null });
            db.prepare("INSERT INTO task_downloads(task_id,state,created_at,updated_at) VALUES(?,'waiting',?,?) ON CONFLICT(task_id) DO UPDATE SET state='waiting',updated_at=excluded.updated_at").run(id, iso(), iso());
            const queuedRoute=connections.getTransportRoute?.(row(id).connection_version_id)||null;
            if(queuedRoute)db.prepare('UPDATE task_downloads SET transport_route_json=? WHERE task_id=? AND transport_route_json IS NULL').run(JSON.stringify(queuedRoute),id);
            if (row(id).lifecycle_version === 2) {
                db.prepare("UPDATE tasks SET generation_outcome='completed',generation_finished_at=?,remote_outcome='confirmed_result' WHERE id=? AND generation_outcome IS NULL").run(iso(),id);
                queueDownloadAttempt(id);
            }
            event(id, 'download_enqueued', { candidateCount: sources.length });
        })();
        if (row(id).lifecycle_version === 2) { telemetry.end(id,'completed',null,ctx); cancelTimer(id); runtime.finish(id); }
        background(pump()); background(drainDownloads());
    }
    async function submit(id, signal) {
        let task = row(id), auth, chosen;
        try {
            auth = connections.getAuth(task.connection_version_id);
            let selected=task.transport_route_json?JSON.parse(task.transport_route_json):JSON.parse(task.input_snapshot_json).transportRoute;
            if(!selected){selected=connections.getTransportRoute?.(task.connection_version_id)||null;if(selected){db.prepare('UPDATE tasks SET transport_route_json=? WHERE id=? AND transport_route_json IS NULL').run(JSON.stringify(selected),id);task=row(id);}}
            auth.transportRoute=routing.snapshot(selected);chosen = adapter(task);
            if (chosen.preflight) await chosen.preflight(task, JSON.parse(task.input_snapshot_json), {...auth,signal});
            store.checkTaskOutputDirectory?.(task);
        } catch (error) {
            if (closed || localOutcome(row(id))) return;
            const code = ['CREDENTIAL_REQUIRED', 'CREDENTIAL_UNAVAILABLE', 'ADAPTER_UNAVAILABLE', 'CAPABILITY_UNVERIFIED','DIRECTORY_NOT_WRITABLE','PATH_TOO_LONG','ASSET_PATH_REJECTED','OUTPUT_DIRECTORY_INVALID'].includes(error.code) ? error.code : 'INPUT_INVALID';
            setError(id, ['INPUT_INVALID', 'CAPABILITY_UNVERIFIED','DIRECTORY_NOT_WRITABLE','PATH_TOO_LONG','ASSET_PATH_REJECTED','OUTPUT_DIRECTORY_INVALID'].includes(code) ? 'failed' : 'polling_paused', code, code.startsWith('CREDENTIAL_') ? 'credential' : 'validation', { pause_reason: code, requires_continue: 1 }, { transmission: 'not_dispatched' });
            return;
        }
        if (closed || row(id).status !== 'local_queued') return;
        // Commit the dispatch boundary BEFORE invoking any adapter network operation.
        const dispatchedAt = now();
        // I01 persists one generation attempt and its absolute deadline; I03 enforces it.
        // Legacy rows have no snapshot and must never acquire a made-up past budget.
        const execution = { execution_attempt_id: randomUUID(), execution_deadline_at: iso(dispatchedAt + (task.execution_timeout_seconds ?? settings()[kind(task)+'TimeoutSeconds']) * 1000) };
        update(id, 'submitting', { dispatch_started_at: iso(dispatchedAt), ...execution, requires_continue: 0, error: null, task_error_json: null }, 'dispatch_started');
        task = row(id); // Adapters must receive the committed attempt and deadline, never the queued row.
        const ctx = context(task); telemetry.record(id,'dispatched',{},ctx); ctx.phase('submitting');
        const accept = upstreamId => {
            ctx.checkpoint();
            if (!isQueryableUpstreamTaskId(upstreamId) || containsCredential(upstreamId,auth.apiKey)) throw fail('SUBMISSION_UNKNOWN');
            const current=row(id);
            if (current.upstream_task_id) {if(current.upstream_task_id!==upstreamId)throw fail('SUBMISSION_UNKNOWN');return;}
            update(id, 'remote_queued', { upstream_task_id: upstreamId, remote_state: 'queued', next_poll_at: iso(now() + rules.intervalMs) }, 'upstream_accepted');
            task=row(id);
        };
        try {
            const accepted = await chosen.submit(task, JSON.parse(task.input_snapshot_json), { ...auth, ...ctx.options, onAccepted:accept });
            ctx.checkpoint();
            const upstreamId=accepted?.upstreamTaskId;
            if (upstreamId!==undefined) accept(upstreamId);
            if (closed) return;
            if (accepted?.resultSources?.length) remoteCompleted(id, accepted.resultSources, auth.apiKey, null, ctx);
            else if (upstreamId) { ctx.phase('remote_waiting'); schedule(id, now() + rules.intervalMs); }
            else throw fail('SUBMISSION_UNKNOWN');
        } catch (error) {
            if (closed || error.code === 'TASK_EXECUTION_ENDED' || localOutcome(row(id))) return;
            ctx.checkpoint();
            telemetry.observe(id,'request_failed',{operation:'submit',errorCategory:classifyError(error),parseOutcome:error.parseOutcome,httpStatus:error.httpStatus},ctx);
            // An adapter may prove a complete explicit rejection. All other POST outcomes are unknown.
            if (row(id).upstream_task_id) {pause(id,'accepted_response_unrecognized','REMOTE_STATUS_UNKNOWN');return;}
            const rejected = error.transmission === 'response_received' && error.definiteRejection === true && !row(id).upstream_task_id;
            const authenticationRejected = rejected && [401,403].includes(error.httpStatus);
            if(rejected && error.modelUnavailable) void connections.modelRejected?.(JSON.parse(row(id).input_snapshot_json).connectionVersionId,auth.transportRoute)?.catch(()=>{});
            setError(id, rejected ? 'failed' : 'submission_unknown', authenticationRejected ? 'AUTH_REJECTED' : rejected && error.modelUnavailable ? 'MODEL_UNAVAILABLE' : rejected ? 'REMOTE_REJECTED' : 'SUBMISSION_UNKNOWN', authenticationRejected ? 'credential' : 'submit', { pause_reason: rejected ? null : 'submission_unknown' }, { transmission: rejected ? 'response_received' : 'may_have_reached_upstream', ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}), ...(error.credentialRedacted ? { message: '上游错误包含连接凭据，已隐藏详情。' } : {}) });
        }
    }
    async function pump() {
        if (closed || updatePaused || pumping) return;
        pumping = true;
        try {
            for (const ctx of [...runtime.active.values()]) { try { ctx.checkpoint(); } catch (error) { if (error.code !== 'TASK_EXECUTION_ENDED') throw error; } }
            const limits = settings(), counts = reservationCounts();
            for (const task of db.prepare("SELECT * FROM tasks WHERE status='local_queued' AND requires_continue=0 ORDER BY created_at,rowid").all()) {
                const media = kind(task);
                if (starting.has(task.id) || counts[media] >= limits[media + 'Concurrency'] || physicalCount(media) >= 5) continue;
                counts[media]++; starting.add(task.id); background(track(task.id, task, signal => submit(task.id,signal)));
            }
        } finally { pumping = false; }
    }
    function pause(id, reason, code, fields = {}, phase = 'poll') {
        cancelTimer(id);
        if (code) setError(id, 'polling_paused', code, phase, { pause_reason: reason, next_poll_at: null, ...fields });
        else update(id, 'polling_paused', { pause_reason: reason, next_poll_at: null }, 'polling_stopped', { remoteMayContinue: true });
    }
    function pollFailure(id, error) {
        const task = row(id);
        const status = error.httpStatus;
        if ([401, 403].includes(status)) { pause(id, 'auth_rejected', 'AUTH_REJECTED'); return; }
        if (['CREDENTIAL_REQUIRED', 'CREDENTIAL_UNAVAILABLE'].includes(error.code)) { pause(id, error.code.toLowerCase(), error.code, {}, 'credential'); return; }
        if (error.code === 'INVALID_UPSTREAM_ID') { pause(id, 'upstream_id_unqueryable', 'REMOTE_STATUS_UNKNOWN'); return; }
        if (error.code === 'ADAPTER_UNAVAILABLE') { pause(id, 'adapter_unavailable', error.code); return; }
        if (error.code === 'REMOTE_STATUS_UNKNOWN' || (status && status !== 429 && status < 500)) { pause(id, 'unrecognized_response', 'REMOTE_STATUS_UNKNOWN'); return; }
        const attempt = task.poll_attempts + 1, started = task.poll_budget_started_at ? Date.parse(task.poll_budget_started_at) : now();
        const remaining = Math.min(rules.budgetMs - (now() - started), context(task).remainingMs()), requested = retryAfter(error.retryAfter, now());
        const delay = requested ?? Math.min(rules.maxDelayMs, Math.round(rules.intervalMs * (2 ** (attempt - 1)) * (0.8 + random() * 0.4)));
        const notBefore = requested !== null ? iso(now() + requested) : null;
        const fields = { poll_attempts: attempt, poll_budget_started_at: iso(started), not_before_at: notBefore };
        const code = status === 429 ? 'RATE_LIMITED' : 'POLL_TRANSIENT';
        if (attempt > rules.maxRetries || remaining <= 0 || delay > rules.maxDelayMs || delay >= remaining) {
            pause(id, requested !== null && delay > rules.maxDelayMs ? 'retry_after_exceeds_budget' : 'retry_budget_exhausted', code, fields); return;
        }
        const next = now() + delay;
        setError(id, task.status, code, 'poll', { ...fields, next_poll_at: iso(next) }, { ...(status ? { httpStatus: status } : {}) });
        schedule(id, next);
    }
    async function poll(id) {
        if (closed || updatePaused || inFlight.has(id)) return;
        let task = row(id);
        if (!task || !REMOTE_ACTIVE.has(task.status) || !task.upstream_task_id) return;
        let ctx; try {ctx = context(task);}catch(error){if(error.code==='TASK_EXECUTION_ENDED')return;throw error;}
        if (!isQueryableUpstreamTaskId(task.upstream_task_id)) { pause(id, 'upstream_id_unqueryable', 'REMOTE_STATUS_UNKNOWN'); return; }
        const due = Math.max(Date.parse(task.not_before_at || '') || 0, Date.parse(task.next_poll_at || '') || 0);
        if (due > now()) { schedule(id, due); return; }
        return track(id, task, async () => {
            let auth;
            try {
                auth = {...connections.getAuth(task.connection_version_id),transportRoute:connections.getTransportRoute?.(task.connection_version_id)||null};
                ctx.checkpoint();
                telemetry.query(id,ctx);
                const outcome = await adapter(task).poll(task, JSON.parse(task.input_snapshot_json), { ...auth, ...ctx.options });
                ctx.checkpoint();
                if (closed || !REMOTE_ACTIVE.has(row(id)?.status)) return; // stopped/closed while GET was in flight
                const remote = outcome?.remoteState, raw = sanitizeRaw(outcome?.rawStatus, auth.apiKey);
                if (!['queued', 'generating', 'completed', 'failed', 'cancelled'].includes(remote)) {
                    telemetry.observe(id,'parse_failed',{operation:'poll',parseOutcome:'unexpected_schema'},ctx);
                    pause(id, 'remote_status_unknown', 'REMOTE_STATUS_UNKNOWN', { remote_state: 'unknown', raw_status: raw }); return;
                }
                if (remote === 'completed') { remoteCompleted(id, outcome.resultSources, auth.apiKey, raw, ctx); return; }
                if (remote === 'failed' || remote === 'cancelled') {
                    setError(id, remote === 'failed' ? 'failed' : 'remote_cancelled', remote === 'failed' ? 'REMOTE_FAILED' : 'REMOTE_CANCELLED', 'poll', { remote_state: remote, raw_status: raw, completed_at: iso(), pause_reason: null, next_poll_at: null }); return;
                }
                const next = now() + rules.intervalMs;
                ctx.phase('remote_waiting');
                update(id, remote === 'queued' ? 'remote_queued' : 'generating', { remote_state: remote, raw_status: raw, ...(typeof outcome.progress==='number' && Number.isFinite(outcome.progress) && outcome.progress>=0 && outcome.progress<=100 ? {remote_progress:outcome.progress}:{}), poll_attempts: 0, poll_budget_started_at: null, next_poll_at: iso(next), not_before_at: null, task_error_json: null, error: null });
                schedule(id, next);
            } catch (error) {
                if (!closed && error.code !== 'TASK_EXECUTION_ENDED' && !localOutcome(row(id)) && REMOTE_ACTIVE.has(row(id)?.status)) { ctx.checkpoint(); telemetry.observe(id,'request_failed',{operation:'poll',errorCategory:classifyError(error),parseOutcome:error.parseOutcome,httpStatus:error.httpStatus},ctx); telemetry.query(id,ctx,error); pollFailure(id, error); }
            }
        });
    }
    function action(id, name, input = {}) {
        if (closed || updatePaused) throw fail('TASK_SERVICE_PAUSED', '任务服务已停止或准备更新，现有记录保留。', 503);
        const task = row(id); if (!task) throw fail('TASK_NOT_FOUND', '找不到任务。', 404);
        if (!input || Object.keys(input).some(key => !(name === 'attach-upstream-id' && key === 'upstreamTaskId') && !(name==='retry-download'&&key==='requestId'))) throw fail('INVALID_TASK_ACTION');
        if (name === 'cancel' || name === 'cancel-task') {
            if (!localOutcome(task) || retryJob(id)) finishLocal(id, 'cancelled', 'TASK_CANCELLED');
        } else if (name === 'cancel-queued') {
            if (task.status === 'local_cancelled' && !task.dispatch_started_at) return publicTask(task);
            if (!['local_queued', 'polling_paused'].includes(task.status) || task.dispatch_started_at || task.upstream_task_id) throw fail('TASK_ALREADY_DISPATCHED', '任务已开始派发，不能取消本地排队。', 409);
            finishLocal(id, 'cancelled', 'TASK_CANCELLED');
        } else if (name === 'continue-queued') {
            if(task.status==='remote_completed'&&task.requires_continue&&!localOutcome(task)) { context(task).checkpoint(); update(id,'remote_completed',{requires_continue:0},'download_continued');background(drainDownloads());return publicTask(row(id)); }
            if (task.status !== 'local_queued' || task.dispatch_started_at) throw fail('TASK_ACTION_INVALID', '该任务不能继续排队。', 409);
            connections.getAuth(task.connection_version_id);
            update(id, 'local_queued', { requires_continue: 0 }, 'queue_continued'); background(pump());
        } else if (name === 'stop-polling') {
            if (!REMOTE_ACTIVE.has(task.status) || !task.upstream_task_id) throw fail('TASK_ACTION_INVALID', '该任务当前没有进行查询。', 409);
            pause(id, 'user_stopped');
        } else if (name === 'resume-polling') {
            if (localOutcome(row(id))) throw fail('TASK_ACTION_INVALID', '任务已在本地结束，不能恢复查询。', 409);
            if (task.status !== 'polling_paused' || !task.upstream_task_id) throw fail('TASK_ACTION_INVALID', '只有保留上游标识的暂停任务可以恢复查询。', 409);
            if (!isQueryableUpstreamTaskId(task.upstream_task_id)) throw fail('INVALID_UPSTREAM_ID', '原上游标识无法安全查询，任务保持暂停。', 409);
            if (inFlight.has(id)) throw fail('TASK_QUERY_BUSY', '原查询尚未结束，请稍后恢复。', 409);
            const earliest = Date.parse(task.not_before_at || '') || 0;
            if (earliest > now()) throw Object.assign(fail('POLL_NOT_BEFORE', '尚未到上游允许的查询时间。', 409), { notBeforeAt: task.not_before_at });
            connections.getAuth(task.connection_version_id); adapter(task);
            context(task).checkpoint();
            update(id, 'remote_queued', { pause_reason: null, error: null, task_error_json: null, requires_continue: 0, next_poll_at: iso(), not_before_at: null }, 'polling_resumed'); schedule(id, now());
        } else if (name === 'attach-upstream-id') {
            if (task.status !== 'submission_unknown' || task.upstream_task_id) throw fail('TASK_ACTION_INVALID', '该任务不需要补充上游标识。', 409);
            const auth = connections.getAuth(task.connection_version_id), value = input.upstreamTaskId;
            if (!isQueryableUpstreamTaskId(value) || containsCredential(value, auth.apiKey)) throw fail('INVALID_UPSTREAM_ID');
            update(id, 'polling_paused', { upstream_task_id: value, pause_reason: 'reconciled_id', error: null, task_error_json: null }, 'submission_reconciled');
        } else if (name === 'retry-download') {
            const requestId=input.requestId===undefined?randomUUID():uuid(input.requestId).toLowerCase();
            const receipt=db.prepare('SELECT * FROM task_download_actions WHERE request_id=?').get(requestId);
            if(receipt){if(receipt.task_id!==id)throw fail('LOCAL_REQUEST_CONFLICT','重新下载请求标识冲突。',409);return {...publicTask(row(id)),acceptedAttemptId:receipt.attempt_id};}
            if(retryJob(id)){const active=retryJob(id);db.prepare('INSERT INTO task_download_actions VALUES(?,?,?,?)').run(requestId,id,active.id,iso());return {...publicTask(row(id)),acceptedAttemptId:active.id};}

            store.checkTaskGroupReady?.(task);
            const missingResult = task.status === 'completed' && store.taskAssets(id, 'output').some(asset => asset.availability !== 'available');
            if (task.status !== 'download_failed' && !missingResult || retryJob(id)) throw fail('TASK_ACTION_INVALID', '该任务没有待重试的下载。', 409);
            if (!task.result_sources_json && !task.upstream_task_id) throw fail('RESULT_REFRESH_REQUIRED', '没有可恢复资源；不会重新生成。', 409);
            if(!recovery(task).canRetryDownload)throw fail('RESULT_NOT_RECOVERABLE','原结果无法安全恢复；不会重新生成。',409);
            const job=db.prepare('SELECT refresh_not_before_at FROM task_downloads WHERE task_id=?').get(id);
            if(Date.parse(job?.refresh_not_before_at || '')>now())throw Object.assign(fail('POLL_NOT_BEFORE','尚未到上游允许的刷新时间。',409),{notBeforeAt:job.refresh_not_before_at});

            if(reservationCounts()[kind(task)]>=settings()[kind(task)+'Concurrency'])throw fail('TASK_CAPACITY_BUSY','该类任务名额已满，请稍后重试下载。',409);
            db.transaction(() => {
                const attemptId=queueDownloadAttempt(id);
                db.prepare('INSERT INTO task_download_actions VALUES(?,?,?,?)').run(requestId,id,attemptId,iso());
                update(id, 'remote_completed', { task_error_json: null, error: null }, missingResult ? 'missing_result_download_requested' : 'download_retry_requested');
                db.prepare("INSERT INTO task_downloads(task_id,state,created_at,updated_at) VALUES(?,'waiting',?,?) ON CONFLICT(task_id) DO UPDATE SET state='waiting',updated_at=excluded.updated_at,refresh_attempts=0,refresh_budget_started_at=NULL").run(id,iso(),iso());
            }).immediate();
            background(drainDownloads());emit(id);return {...publicTask(row(id)),acceptedAttemptId:db.prepare('SELECT attempt_id FROM task_download_actions WHERE request_id=?').get(requestId).attempt_id};
        } else throw fail('TASK_ACTION_INVALID');
        emit(id); return publicTask(row(id));
    }
    function queueDownloadAttempt(id) {
        const task=row(id), attemptId=randomUUID(), timeoutSeconds=settings()[kind(task)+'DownloadTimeoutSeconds'];
        const selected=connections.getTransportRoute?.(task.connection_version_id)||null;
        db.prepare('INSERT INTO task_download_attempts(id,task_id,timeout_seconds,queued_at,transport_route_json) VALUES(?,?,?,?,?)').run(attemptId,id,timeoutSeconds,iso(),selected?JSON.stringify(selected):null);
        return attemptId;
    }
    async function refreshDownload(task, ctx) {
        ctx.checkpoint();ctx.options.progressTracker?.phase('refreshing');
        if(!task.upstream_task_id||!isQueryableUpstreamTaskId(task.upstream_task_id))throw downloadFailure('RESULT_NOT_RECOVERABLE');
        const job=db.prepare('SELECT * FROM task_downloads WHERE task_id=?').get(task.id);
        if(Date.parse(job.refresh_not_before_at || '')>now())throw downloadFailure('RATE_LIMITED');
        if(job.refresh_attempts>=rules.maxRetries)throw downloadFailure('DOWNLOAD_EXPIRED');
        const started=job.refresh_budget_started_at?Date.parse(job.refresh_budget_started_at):now();
        if(now()-started>=rules.budgetMs)throw downloadFailure('DOWNLOAD_EXPIRED');
        db.prepare('UPDATE task_downloads SET refresh_attempts=refresh_attempts+1,refresh_budget_started_at=? WHERE task_id=?').run(iso(started),task.id);
        const auth={...connections.getAuth(task.connection_version_id),transportRoute:ctx.options.transportRoute};
        try {
            telemetry.query(task.id,ctx);
            const outcome=await adapter(task).poll(task,JSON.parse(task.input_snapshot_json),{...auth,...ctx.options}); ctx.checkpoint();
            if(outcome?.remoteState!=='completed')throw downloadFailure('DOWNLOAD_EXPIRED');
            const saved=candidates(task,outcome.resultSources,auth.apiKey,ctx); ctx.checkpoint();
            db.prepare('UPDATE tasks SET result_sources_json=? WHERE id=?').run(JSON.stringify(saved),task.id);
            event(task.id,'download_source_refreshed',{sameUpstreamTask:true});
            return ephemeralSources.get(task.id)||saved;
        } catch(error) {
            if(error.code==='TASK_EXECUTION_ENDED')throw error;
            telemetry.observe(task.id,'request_failed',{operation:'poll',errorCategory:classifyError(error),parseOutcome:error.parseOutcome,httpStatus:error.httpStatus},ctx);
            telemetry.query(task.id,ctx,error);
            const wait=retryAfter(error.retryAfter,now());
            if(wait!==null)db.prepare('UPDATE task_downloads SET refresh_not_before_at=? WHERE task_id=?').run(iso(now()+wait),task.id);
            if([401,403].includes(error.httpStatus))throw downloadFailure('AUTH_REJECTED');
            if(error.httpStatus===429)throw downloadFailure('RATE_LIMITED');
            if(['CREDENTIAL_REQUIRED','CREDENTIAL_UNAVAILABLE'].includes(error.code))throw downloadFailure(error.code);
            throw DETAILS[error.code]?error:downloadFailure('DOWNLOAD_EXPIRED');
        }
    }
    function readCheckpoint(taskId,source){
            if(!source.sourceKey)return null;
            const file=db.prepare('SELECT * FROM task_download_files WHERE task_id=? AND source_key=?').get(taskId,source.sourceKey);
            if(!file)return null;
            try{const checked=store.readAsset(file.asset_id);if(checked.asset.validationState!=='verified'||checked.asset.sha256!==file.sha256||checked.bytes.length!==file.byte_length||createHash('sha256').update(checked.bytes).digest('hex')!==file.sha256)return null;return {assetId:file.asset_id,byteLength:file.byte_length};}catch{return null;}
    }
    function recovery(task) {
        let sources;try{sources=JSON.parse(task.result_sources_json||'null');}catch{}
        const generated=task.generation_outcome==='completed'||task.remote_state==='completed'||Boolean(sources);
        const missing=task.status==='completed'&&store.taskAssets(task.id,'output').some(asset=>asset.availability!=='available');
        if(retryJob(task.id)||task.status==='completed'&&!missing)return {canRetryDownload:false,recoveryKind:'none',recoveryReason:null};
        let recoveryKind='none';
        if(sources?.length&&sources.every(source=>source.kind!=='ephemeral'))recoveryKind='stored';
        else if(ephemeralSources.has(task.id))recoveryKind='session';
        else if(sources?.length&&sources.every(source=>{const file=db.prepare('SELECT * FROM task_download_files WHERE task_id=? AND source_key=?').get(task.id,source.sourceKey||'');if(!file)return false;try{const asset=store.getAsset(file.asset_id);return asset.availability==='available'&&asset.validationState==='verified'&&asset.sha256===file.sha256&&asset.byteLength===file.byte_length;}catch{return false;}}))recoveryKind='checkpoints';
        if(recoveryKind==='none'&&isQueryableUpstreamTaskId(task.upstream_task_id)){try{if(typeof adapter(task).poll==='function')recoveryKind='upstream';}catch{}}

        return {canRetryDownload:generated&&recoveryKind!=='none'&&!retryJob(task.id)&&(task.status==='download_failed'||missing),recoveryKind,recoveryReason:generated&&recoveryKind==='none'?'原结果暂时无法恢复；临时链接可能已丢失，且当前无法通过原任务查询。不会重新生成。':recoveryKind==='session'?'原结果临时链接仅本次运行可恢复；请在退出前完成下载。':null};
    }
    store.setRecoveryResolver?.(recovery);
    // One projection for task HTTP/WS/action responses and storage history.
    function publicTask(task) { return task ? store.getTask(task.id) : null; }

    async function drainDownloads() {
        if (closed || updatePaused || !downloadWorker) return;
        const limits=settings(), running={image:0,video:0};
        for (const entry of inFlight.entries()) if(entry[0].startsWith('download:'))running[entry[1].kind]++;
        for (const job of db.prepare("SELECT d.* FROM task_downloads d JOIN tasks t ON t.id=d.task_id WHERE d.state='waiting' AND t.requires_continue=0 ORDER BY d.created_at,d.rowid").all()) {
            const task=row(job.task_id), media=kind(task);
            if(inFlight.has('download:'+task.id)||inFlight.has(task.id)||running[media]>=limits[media+'Concurrency']||physicalCount(media)>=5)continue;
            if(localOutcome(task)&&!retryJob(task.id))continue;
            running[media]++; background(runDownload(job,task));
        }
    }
    async function runDownload(job, original) {
        let ctx;
        try {
            const attempt=retryJob(original.id);
            if (attempt && !attempt.started_at) db.prepare('UPDATE task_download_attempts SET started_at=?,deadline_at=? WHERE id=? AND started_at IS NULL AND outcome IS NULL').run(iso(),iso(now()+attempt.timeout_seconds*1000),attempt.id);
            ctx=context(row(original.id));
        }catch(error){if(error.code==='TASK_EXECUTION_ENDED')return;throw error;}
        const queuedRoute=ctx.downloadAttempt?.transport_route_json||(!ctx.downloadAttempt?job.transport_route_json:null);
        ctx.options.transportRoute=queuedRoute?JSON.parse(queuedRoute):connections.getTransportRoute?.(original.connection_version_id)||null;
        if(ctx.downloadAttempt&&!ctx.downloadAttempt.transport_route_json&&ctx.options.transportRoute)db.prepare('UPDATE task_download_attempts SET transport_route_json=? WHERE id=? AND transport_route_json IS NULL').run(JSON.stringify(ctx.options.transportRoute),ctx.token);
        ctx.options.readCheckpoint=source=>readCheckpoint(original.id,source);
        ctx.options.saveCheckpoint=(source,index,assetId)=>{ctx.checkpoint();if(!source.sourceKey)return;const asset=store.getAsset(assetId);db.prepare('INSERT INTO task_download_files VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,source_key) DO UPDATE SET asset_id=excluded.asset_id,sha256=excluded.sha256,byte_length=excluded.byte_length,position=excluded.position').run(original.id,source.sourceKey,assetId,asset.sha256,asset.byteLength,index);};
        ctx.options.legacyDownloadLimit=original.lifecycle_version===1&&!ctx.downloadAttempt;
        let progress, lastSnapshot=null,lastPersist=-Infinity;
        if (ctx.downloadAttempt) {
            const attempt=ctx.downloadAttempt, count=db.prepare('SELECT count(*) AS n FROM task_download_attempts WHERE task_id=?').get(original.id).n;
            // The worker sets the list size and emits through one tracker for all source refreshes.
            ctx.options.progressOptions={checkpoint:ctx.checkpoint,now,monotonic:monotonic || (now===Date.now?undefined:now),setTimer:(fn,ms)=>{let handle;const loop=()=>{fn();if(!ctx.controller.signal.aborted)handle=setTimer(loop,ms);};handle=setTimer(loop,ms);return {stop:()=>clearTimer(handle)};},clearTimer:handle=>handle.stop(),
                onProgress:value=>{ctx.checkpoint(); const previous=lastSnapshot;
                    lastSnapshot={...value,attemptId:attempt.id,attemptNumber:count,retryCount:count-(original.lifecycle_version===2?1:0),startedAt:attempt.started_at,deadlineAt:attempt.deadline_at,timeoutSeconds:attempt.timeout_seconds};
                    store.setLiveDownloadProgress(attempt.id,lastSnapshot);
                    if(!previous||previous.phase!==value.phase||previous.fileIndex!==value.fileIndex||ctx.elapsedMs()-lastPersist>=5000){db.prepare('UPDATE task_download_attempts SET progress_json=? WHERE id=? AND outcome IS NULL').run(JSON.stringify(lastSnapshot),ctx.token);lastPersist=ctx.elapsedMs();}
                    emit(original.id);
                }};
            progress=createDownloadProgress({...ctx.options.progressOptions,fileCount:JSON.parse(original.result_sources_json||'[]').length});ctx.options.progressTracker=progress;
        }
        const endProgress=phase=>persistFinalDownloadProgress(original.id,ctx,phase);
        downloadsRunning++;
        return track('download:'+job.task_id,original,async () => {
            ctx.checkpoint(); ctx.phase('downloading');
            update(job.task_id, 'downloading'); db.prepare("UPDATE task_downloads SET state='running',updated_at=? WHERE task_id=?").run(iso(), job.task_id);
            try {
                // T08 must return an independently verifiable proof; no caller can merely set completed.
                const task=row(job.task_id);
                store.checkTaskGroupReady?.(task);
                let proof;
                    let sources=ephemeralSources.get(task.id)||JSON.parse(task.result_sources_json || 'null');
                    let refreshed=false;
                    if(!sources||sources.some(source=>source.kind==='ephemeral'&&!ctx.options.readCheckpoint(source))){sources=await refreshDownload(task,ctx);refreshed=true;}
                    try { proof=await downloadWorker(task,sources,ctx.options); }
                    catch(error) { if(error.code!=='DOWNLOAD_EXPIRED'||refreshed||!task.upstream_task_id)throw error;
                        ctx.checkpoint();sources=await refreshDownload(task,ctx);proof=await downloadWorker(task,sources,ctx.options); }
                ctx.checkpoint(); ctx.phase('saving');
                if (!proof?.assetIds?.length || proof.assetIds.length!==sources.length) throw fail('DOWNLOAD_FAILED');
                for (const id of proof.assetIds) { const checked = store.readAsset(id); if (checked.asset.validationState !== 'verified') throw fail('DOWNLOAD_FAILED'); }
                ctx.checkpoint();
                db.transaction(() => { ctx.checkpoint(); store.bindTaskAssets(job.task_id, proof.assetIds.map((assetId, position) => ({ assetId, position, role: 'reference' })), 'output'); ctx.checkpoint(); update(job.task_id, 'completed', localOutcome(row(job.task_id)) ? {} : { completed_at: iso() }); db.prepare("UPDATE task_downloads SET state='completed',updated_at=? WHERE task_id=?").run(iso(), job.task_id); if(ctx.downloadAttempt)db.prepare("UPDATE task_download_attempts SET outcome='completed',finished_at=? WHERE id=? AND outcome IS NULL").run(iso(),ctx.token); })();
                endProgress('completed');runtime.finish(task.id);
                ephemeralSources.delete(job.task_id);
            } catch (error) {
                // A synchronous bind may cross the deadline inside a transaction. Its rollback
                // must not roll back the winning local terminal state as well.
                if(error.code==='TASK_EXECUTION_ENDED'&&ctx.endedOutcome&&(ctx.downloadAttempt?retryJob(job.task_id)?.id===ctx.token:!localOutcome(row(job.task_id))))finishLocal(job.task_id,ctx.endedOutcome,ctx.endedOutcome==='timed_out'?(ctx.downloadAttempt?'DOWNLOAD_TIMEOUT':'TASK_TIMED_OUT'):'TASK_CANCELLED',ctx);
                if (!closed && error.code!=='TASK_EXECUTION_ENDED' && (ctx.downloadAttempt ? retryJob(job.task_id)?.id===ctx.token : !localOutcome(row(job.task_id)))) {
                    ctx.checkpoint();const code=DETAILS[error.code]?error.code:'DOWNLOAD_FAILED';setError(job.task_id, 'download_failed', code, DETAILS[code]?.[0] || 'download'); db.prepare("UPDATE task_downloads SET state='failed',updated_at=? WHERE task_id=?").run(iso(), job.task_id);
                    if(ctx.downloadAttempt)db.prepare("UPDATE task_download_attempts SET outcome='failed',finished_at=? WHERE id=? AND outcome IS NULL").run(iso(),ctx.token);runtime.finish(job.task_id);
                }
            }
        }).finally(()=>{const attempt=db.prepare('SELECT outcome FROM task_download_attempts WHERE id=?').get(ctx.token);endProgress(attempt?.outcome==='completed'?'completed':attempt?.outcome==='cancelled'?'cancelled':'failed');downloadsRunning--;wake();});
    }
    function recover() {
        db.transaction(() => {
            for (const task of db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all()) {
                const retry=retryJob(task.id);
                if(retry||!localOutcome(task))telemetry.record(task.id,'recovery_observed');
                if(retry){db.prepare("UPDATE task_download_attempts SET outcome='failed',finished_at=? WHERE id=? AND outcome IS NULL").run(iso(),retry.id);db.prepare("UPDATE task_downloads SET state='failed',updated_at=? WHERE task_id=?").run(iso(),task.id);db.prepare("UPDATE tasks SET status='download_failed',local_outcome=COALESCE(local_outcome,'failed'),local_finished_at=COALESCE(local_finished_at,?) WHERE id=?").run(iso(),task.id);const saved=JSON.parse(task.result_sources_json||'null'),code=recovery(task).recoveryKind==='none'?'RESULT_NOT_RECOVERABLE':'DOWNLOAD_INTERRUPTED',error=errorDto(code,'download',task);db.prepare('UPDATE task_download_attempts SET error_code=? WHERE id=?').run(code,retry.id);db.prepare('UPDATE tasks SET task_error_json=?,error=? WHERE id=?').run(JSON.stringify(error),error.message,task.id);if(retry.progress_json){const progress={...JSON.parse(retry.progress_json),phase:'failed',bytesPerSecond:0,stalled:false};db.prepare('UPDATE task_download_attempts SET progress_json=? WHERE id=?').run(JSON.stringify(progress),retry.id);}store.setLiveDownloadProgress(retry.id,null);event(task.id,'download_attempt_interrupted',{sameGeneration:true});continue;}
                if (localOutcome(task)) continue;
                if (['queued', '排队中', 'local_queued'].includes(task.status) && !task.dispatch_started_at && !task.upstream_task_id) {
                    if(task.status!=='local_queued'||!task.requires_continue)update(task.id, 'local_queued', { requires_continue: 1 }, 'recovery_queue_waiting'); continue;
                }
                if (!task.execution_attempt_id || !task.execution_deadline_at) { finishLocal(task.id,'failed','LEGACY_EXECUTION_ENDED');continue; }
                const deadline=Date.parse(task.execution_deadline_at), dispatched=Date.parse(task.dispatch_started_at);
                if(!Number.isFinite(deadline)||!Number.isFinite(dispatched)||deadline<=now()||now()<dispatched||deadline-now()>(task.execution_timeout_seconds??((deadline-dispatched)/1000))*1000){finishLocal(task.id,'timed_out','TASK_TIMED_OUT');continue;}
                if (['remote_completed', 'downloading', 'download_failed'].includes(task.status)) {
                    const saved=JSON.parse(task.result_sources_json || 'null');
                    if((!saved||saved.some(source=>source.kind==='ephemeral'))&&!task.upstream_task_id){setError(task.id,'download_failed','RESULT_NOT_RECOVERABLE','download');db.prepare("UPDATE task_downloads SET state='failed',updated_at=? WHERE task_id=?").run(iso(),task.id);continue;}
                    if (task.status !== 'remote_completed'||!task.requires_continue) update(task.id, 'remote_completed', {requires_continue:1}, 'recovery_download_waiting');
                    db.prepare("UPDATE task_downloads SET state=CASE WHEN state='running' THEN 'waiting' ELSE state END,updated_at=? WHERE task_id=?").run(iso(), task.id); continue;
                }
                const legacy = JSON.parse(task.request_json || '{}');
                const id = task.upstream_task_id || (typeof legacy.upstreamTaskId === 'string' ? legacy.upstreamTaskId : null);
                if (id && !isQueryableUpstreamTaskId(id)) {
                    if(task.pause_reason!=='upstream_id_unqueryable'||!task.requires_continue)setError(task.id, 'polling_paused', 'REMOTE_STATUS_UNKNOWN', 'poll', { pause_reason: 'upstream_id_unqueryable', upstream_task_id: id, next_poll_at: null,requires_continue:1 });
                } else if (id) {
                    if(task.status!=='polling_paused'||!task.requires_continue)update(task.id,'polling_paused',{upstream_task_id:id,pause_reason:task.status==='polling_paused'?task.pause_reason:'restart_resume_required',requires_continue:1,next_poll_at:null},'recovery_user_continue_required');
                } else finishLocal(task.id,'failed','RESTART_RESULT_UNAVAILABLE');
            }
        })();
        for (const task of db.prepare('SELECT * FROM tasks WHERE local_outcome IS NULL AND execution_attempt_id IS NOT NULL').all()) if(ACTIVE.has(task.status)&&!task.generation_outcome)runtime.start(task);
    }
    function stats() {
        const counts = Object.fromEntries(db.prepare('SELECT status,count(*) AS n FROM tasks GROUP BY status').all().map(item => [item.status, item.n]));
        const limits=settings(),byMedia=reservationCounts();
        const processing=byMedia.image+byMedia.video,queued=counts.local_queued||0;
        return { concurrencyLimit: limits.imageConcurrency+limits.videoConcurrency, configuredConcurrency: limits.imageConcurrency+limits.videoConcurrency, imageConcurrency:limits.imageConcurrency,videoConcurrency:limits.videoConcurrency,imageProcessing:byMedia.image,videoProcessing:byMedia.video,processingCount: processing, queuedCount: queued, pendingCount: processing + queued,
            displayConcurrency: processing, displayQueued: queued, downloadConcurrency: limits.imageConcurrency+limits.videoConcurrency, downloadsRunning, physicalOperations:inFlight.size, schedulerError, acceptingNewTasks:!closed && !updatePaused && !schedulerError,
            downloadQueued: db.prepare("SELECT count(*) AS n FROM task_downloads WHERE state='waiting'").get().n, pausedCount: counts.polling_paused || 0,
            awaitingContinueCount: db.prepare("SELECT count(*) AS n FROM tasks WHERE status='local_queued' AND requires_continue=1").get().n };
    }
    function prepareUpdate() {
        if (closed || schedulerError || updatePaused) throw fail('UPDATE_BUSY', '任务仍在处理中，请稍后更新。', 503);
        updatePaused = true;
        // Synchronous admission barrier: neither queued microtasks nor timers can start work now.
        if (inFlight.size || pumping || downloadsRunning) { updatePaused = false; throw fail('UPDATE_BUSY', '任务或媒体仍在处理中，请稍后更新。', 503); }
        if (ephemeralSources.size) { updatePaused = false; throw fail('UPDATE_UNSAVED_RESULT', '仍有仅在本次运行中可取回的结果，请先完成结果保存。', 503); }
        if (db.prepare('SELECT 1 FROM workbench_submission_intents i WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.local_request_id=i.local_request_id) LIMIT 1').get()) { updatePaused = false; throw fail('UPDATE_SUBMISSION_PENDING', '请先核对未完成的本地提交意图。', 503); }
        for (const timer of timers.values()) clearTimer(timer); timers.clear();
        return { remoteMayContinue: !!db.prepare("SELECT 1 FROM tasks WHERE status IN ('submitting','submission_unknown','remote_queued','generating','polling_paused') AND (dispatch_started_at IS NOT NULL OR upstream_task_id IS NOT NULL) LIMIT 1").get() };
    }
    function releaseUpdate() {
        if (closed || !updatePaused) return;
        updatePaused = false;
        for(const task of db.prepare('SELECT * FROM tasks WHERE local_outcome IS NULL').all())if(ACTIVE.has(task.status)&&task.execution_attempt_id&&!task.generation_outcome)runtime.start(task);
        for (const task of db.prepare("SELECT * FROM tasks WHERE status IN ('remote_queued','generating')").all()) schedule(task.id, Math.max(Date.parse(task.next_poll_at || '') || now(), Date.parse(task.not_before_at || '') || 0));
        background(pump()); background(drainDownloads());
    }
    function persistUpdatePause() {
        if (!updatePaused || closed || inFlight.size || pumping || downloadsRunning) throw fail('UPDATE_BUSY');
        db.transaction(() => {
            for (const task of db.prepare("SELECT id FROM tasks WHERE status IN ('remote_queued','generating')").all()) pause(task.id, 'application_update');
            db.prepare("UPDATE tasks SET requires_continue=1 WHERE status='local_queued' AND dispatch_started_at IS NULL AND upstream_task_id IS NULL").run();
        })();
        runtime.close();
    }
    function finishUpdate() { closed = true; runtime.close(); ephemeralSources.clear(); }
    async function close() { closed = true; runtime.close(); for(const entry of inFlight.values())entry.controller.abort(); for (const timer of timers.values()) clearTimer(timer); timers.clear(); await Promise.allSettled([...inFlight.values()].map(entry=>entry.promise)); ephemeralSources.clear(); }
    store.setGroupActivityGuard?.(id=>starting.has(id)||inFlight.has(id)||inFlight.has('download:'+id));
    return { hasTaskIO:id=>starting.has(id)||inFlight.has(id)||inFlight.has('download:'+id), enqueue, findDuplicate, action, recover, stats, close, prepareUpdate, releaseUpdate, persistUpdatePause, finishUpdate, settingsChanged:wake, get: id => publicTask(row(id)), poll, pump, drainDownloads };
}
module.exports = { createTaskService, canonical, retryAfter, DEFAULT_POLICY, STATES };
