'use strict';
const { randomUUID } = require('node:crypto');
const { UUID, fail } = require('../storage/store');
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) throw fail('INVALID_ID'); return value; };
const { containsCredential } = require('../connections/redaction');
const { isQueryableUpstreamTaskId } = require('../plugin-runtime/upstream-id');
const TERMINAL = new Set(['completed', 'failed', 'local_cancelled', 'remote_cancelled']);
const REMOTE_ACTIVE = new Set(['remote_queued', 'generating']);
const RESERVING = new Set(['submitting', 'submission_unknown', 'remote_queued', 'generating', 'polling_paused']);
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
};
function errorDto(code, phase, task, extra = {}) {
    return { code, phase, message: MESSAGES[code] || '任务已暂停，请检查详情。', retryAction: ({
        SUBMISSION_UNKNOWN: 'reconcile_submission', REMOTE_REJECTED: 'edit_input', INPUT_INVALID: 'edit_input', CAPABILITY_UNVERIFIED: 'edit_input',
        AUTH_REJECTED: 'reauthenticate', CREDENTIAL_REQUIRED: 'reauthenticate', CREDENTIAL_UNAVAILABLE: 'reauthenticate',
        POLL_TRANSIENT: 'retry_poll', RATE_LIMITED: 'retry_poll', REMOTE_STATUS_UNKNOWN: 'retry_poll',
        DOWNLOAD_FAILED: 'retry_download', DOWNLOAD_EXPIRED: 'retry_download',
    })[code] || 'none', transmission: phase === 'submit' ? 'may_have_reached_upstream' : 'not_applicable',
    localTaskId: task.id, ...(task.upstream_task_id ? { upstreamTaskId: task.upstream_task_id } : {}), ...extra };
}
/** Desktop-only durable orchestration. Adapters perform exactly one submit or one GET.
 * Download workers are injected by T08; without one, candidates remain remote_completed.
 */
function createTaskService({ db, store, connections, resolveAdapter, onChange = () => {}, now = Date.now, random = Math.random, policy = {}, downloadWorker = null }) {
    const rules = { ...DEFAULT_POLICY, ...policy }, timers = new Map(), inFlight = new Map(), controllers = new Set();
    let closed = false, pumping = false, downloadsRunning = 0, schedulerError = null;
    function background(promise) { promise.catch(() => { schedulerError = 'STORAGE_OPERATION_FAILED'; closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); for (const controller of controllers) controller.abort(); }); }
    const iso = ms => new Date(Math.min(8640000000000000, ms ?? now())).toISOString();
    const row = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(uuid(id));
    const event = (id, type, payload = {}) => store.appendTaskEvent(id, type, payload);
    const emit = id => queueMicrotask(() => { if (!closed) onChange(id); });
    function update(id, state, fields = {}, type = 'task_transition', payload = {}) {
        if (!STATES.has(state)) throw fail('TASK_STATE_INVALID');
        db.transaction(() => {
            const before = row(id);
            if (!before) throw fail('TASK_NOT_FOUND', '找不到任务。', 404);
            if (TERMINAL.has(before.status) && state !== before.status) throw fail('TASK_ACTION_INVALID', '任务已经结束。', 409);
            const allowed = ['upstream_task_id', 'dispatch_started_at', 'remote_state', 'raw_status', 'remote_progress', 'pause_reason', 'not_before_at', 'next_poll_at', 'poll_attempts', 'poll_budget_started_at', 'task_error_json', 'error', 'requires_continue', 'result_sources_json', 'completed_at'];
            if (Object.keys(fields).some(key => !allowed.includes(key))) throw fail('TASK_STATE_INVALID');
            db.prepare('UPDATE tasks SET status=?' + Object.keys(fields).map(key => ',' + key + '=?').join('') + ' WHERE id=?').run(state, ...Object.values(fields), id);
            event(id, type, { previous: before.status, next: state, ...payload });
        }).immediate();
        emit(id);
    }
    function setError(id, state, code, phase, fields = {}, extra = {}) {
        const task = row(id), error = errorDto(code, phase, task, extra);
        if (TERMINAL.has(state) && !fields.completed_at) fields.completed_at=iso();
        update(id, state, { task_error_json: JSON.stringify(error), error: error.message, ...fields }, code.startsWith('CREDENTIAL_') ? 'credential_access_paused' : 'task_error', { code, phase });
    }
    function cancelTimer(id) { const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id); }
    function schedule(id, when) {
        cancelTimer(id);
        if (closed) return;
        const delay = Math.max(0, when - now());
        const timer = setTimeout(() => { timers.delete(id); background(poll(id)); }, Math.min(delay, 2147483647));
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
        if (canonical(JSON.parse(existing.input_snapshot_json)) !== canonical(checked)) throw fail('LOCAL_REQUEST_CONFLICT', '同一本地请求标识对应不同任务输入。', 409);
        return existing.id;
    }
    function enqueue({ snapshot: input, request, mode }) {
        if (closed) throw fail('SERVER_NOT_ACCEPTING_TASKS', '服务正在关闭。', 503);
        const snapshot = snapshotFor(input), duplicate = findDuplicate(snapshot);
        if (duplicate) return duplicate;
        // A controlled preflight can establish not_dispatched. No key is kept in the record.
        connections.getAuth(snapshot.connectionVersionId);
        const id = randomUUID();
        db.transaction(() => {
            db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(id, 'local_queued', mode, JSON.stringify(request), iso());
            store.setTaskSnapshot(id, snapshot);
            event(id, 'task_enqueued', { contractVersion: 1 });
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
    function candidates(task, result, key) {
        if (!Array.isArray(result) || result.length === 0 || result.length > 32) throw fail('REMOTE_STATUS_UNKNOWN');
        return result.map(source => {
            if (source.kind === 'asset') { store.readAsset(source.assetId); return { kind: 'asset', assetId: source.assetId }; }
            if (source.kind === 'inline') {
                const asset = store.importBuffer(source.bytes, { mimeType: source.mimeType, sourceKind: 'generated' });
                return { kind: 'asset', assetId: asset.assetId };
            }
            const url = new URL(source.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || containsCredential(url.toString(), key)) throw Object.assign(fail('DOWNLOAD_EXPIRED'), { credentialRedacted: containsCredential(url.toString(), key) });
            // Signed/query-bearing addresses remain ephemeral. T08 can refresh the same ID.
            if (url.search) throw fail('DOWNLOAD_EXPIRED');
            return { kind: 'url', url: url.toString(), authScope: source.authScope === 'connection' ? 'connection' : 'none', mediaKind: source.mediaKind || 'image' };
        });
    }
    function remoteCompleted(id, result, key, rawStatus = null) {
        let sources;
        try { sources = candidates(row(id), result, key); }
        catch (error) { setError(id, 'download_failed', error.code === 'DOWNLOAD_EXPIRED' ? 'DOWNLOAD_EXPIRED' : 'DOWNLOAD_FAILED', 'download', { remote_state: 'completed', pause_reason: null, next_poll_at: null }, error.credentialRedacted ? { message: '上游资源地址包含连接凭据，已停止下载。' } : {}); background(pump()); return; }
        db.transaction(() => {
            update(id, 'remote_completed', { result_sources_json: JSON.stringify(sources), remote_state: 'completed', raw_status: rawStatus, remote_progress: 100, task_error_json: null, error: null, next_poll_at: null, pause_reason: null });
            db.prepare("INSERT INTO task_downloads(task_id,state,created_at,updated_at) VALUES(?,'waiting',?,?) ON CONFLICT(task_id) DO UPDATE SET state='waiting',updated_at=excluded.updated_at").run(id, iso(), iso());
            event(id, 'download_enqueued', { candidateCount: sources.length });
        })();
        background(pump()); background(drainDownloads());
    }
    async function submit(id) {
        let task = row(id), auth, chosen;
        try {
            auth = connections.getAuth(task.connection_version_id); chosen = adapter(task);
            if (chosen.preflight) await chosen.preflight(task, JSON.parse(task.input_snapshot_json), auth);
        } catch (error) {
            const code = ['CREDENTIAL_REQUIRED', 'CREDENTIAL_UNAVAILABLE', 'ADAPTER_UNAVAILABLE', 'CAPABILITY_UNVERIFIED'].includes(error.code) ? error.code : 'INPUT_INVALID';
            setError(id, ['INPUT_INVALID', 'CAPABILITY_UNVERIFIED'].includes(code) ? 'failed' : 'polling_paused', code, code.startsWith('CREDENTIAL_') ? 'credential' : 'validation', { pause_reason: code, requires_continue: 1 }, { transmission: 'not_dispatched' });
            return;
        }
        if (closed || row(id).status !== 'local_queued') return;
        // Commit the dispatch boundary BEFORE invoking any adapter network operation.
        update(id, 'submitting', { dispatch_started_at: iso(), requires_continue: 0, error: null, task_error_json: null }, 'dispatch_started');
        const accept = upstreamId => {
            if (!isQueryableUpstreamTaskId(upstreamId) || containsCredential(upstreamId,auth.apiKey)) throw fail('SUBMISSION_UNKNOWN');
            const current=row(id);
            if (current.upstream_task_id) {if(current.upstream_task_id!==upstreamId)throw fail('SUBMISSION_UNKNOWN');return;}
            update(id, 'remote_queued', { upstream_task_id: upstreamId, remote_state: 'queued', next_poll_at: iso(now() + rules.intervalMs) }, 'upstream_accepted');
            task=row(id);
        };
        try {
            const controller = new AbortController(); controllers.add(controller);
            let accepted;
            try { accepted = await chosen.submit(task, JSON.parse(task.input_snapshot_json), { ...auth, signal: controller.signal, onAccepted:accept }); }
            finally { controllers.delete(controller); }
            const upstreamId=accepted?.upstreamTaskId;
            if (upstreamId!==undefined) accept(upstreamId);
            if (closed) return;
            if (accepted?.resultSources?.length) remoteCompleted(id, accepted.resultSources, auth.apiKey);
            else if (upstreamId) schedule(id, now() + rules.intervalMs);
            else throw fail('SUBMISSION_UNKNOWN');
        } catch (error) {
            if (closed) return;
            // An adapter may prove a complete explicit rejection. All other POST outcomes are unknown.
            if (row(id).upstream_task_id) {pause(id,'accepted_response_unrecognized','REMOTE_STATUS_UNKNOWN');return;}
            const rejected = error.transmission === 'response_received' && error.definiteRejection === true && !row(id).upstream_task_id;
            const authenticationRejected = rejected && [401,403].includes(error.httpStatus);
            setError(id, rejected ? 'failed' : 'submission_unknown', authenticationRejected ? 'AUTH_REJECTED' : rejected ? 'REMOTE_REJECTED' : 'SUBMISSION_UNKNOWN', authenticationRejected ? 'credential' : 'submit', { pause_reason: rejected ? null : 'submission_unknown' }, { transmission: rejected ? 'response_received' : 'may_have_reached_upstream', ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}), ...(error.credentialRedacted ? { message: '上游错误包含连接凭据，已隐藏详情。' } : {}) });
        }
    }
    async function pump() {
        if (closed || pumping) return;
        pumping = true;
        try {
            if (db.prepare("SELECT 1 FROM tasks WHERE status IN ('submitting','submission_unknown','remote_queued','generating','polling_paused') AND (dispatch_started_at IS NOT NULL OR upstream_task_id IS NOT NULL) LIMIT 1").get()) return;
            const next = db.prepare("SELECT id FROM tasks WHERE status='local_queued' AND requires_continue=0 ORDER BY created_at,id LIMIT 1").get();
            if (!next) return;
            const promise = submit(next.id); inFlight.set(next.id, promise);
            try { await promise; } finally { inFlight.delete(next.id); }
        } finally { pumping = false; }
        if (!closed) queueMicrotask(() => background(pump()));
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
        const remaining = rules.budgetMs - (now() - started), requested = retryAfter(error.retryAfter, now());
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
        if (closed || inFlight.has(id)) return;
        let task = row(id);
        if (!task || !REMOTE_ACTIVE.has(task.status) || !task.upstream_task_id) return;
        if (!isQueryableUpstreamTaskId(task.upstream_task_id)) { pause(id, 'upstream_id_unqueryable', 'REMOTE_STATUS_UNKNOWN'); return; }
        const due = Math.max(Date.parse(task.not_before_at || '') || 0, Date.parse(task.next_poll_at || '') || 0);
        if (due > now()) { schedule(id, due); return; }
        const promise = (async () => {
            let auth;
            try {
                auth = connections.getAuth(task.connection_version_id);
                const controller = new AbortController(); controllers.add(controller);
                let outcome;
                try { outcome = await adapter(task).poll(task, JSON.parse(task.input_snapshot_json), { ...auth, signal: controller.signal }); }
                finally { controllers.delete(controller); }
                if (closed || !REMOTE_ACTIVE.has(row(id)?.status)) return; // stopped/closed while GET was in flight
                const remote = outcome?.remoteState, raw = sanitizeRaw(outcome?.rawStatus, auth.apiKey);
                if (!['queued', 'generating', 'completed', 'failed', 'cancelled'].includes(remote)) {
                    pause(id, 'remote_status_unknown', 'REMOTE_STATUS_UNKNOWN', { remote_state: 'unknown', raw_status: raw }); return;
                }
                if (remote === 'completed') { remoteCompleted(id, outcome.resultSources, auth.apiKey, raw); return; }
                if (remote === 'failed' || remote === 'cancelled') {
                    setError(id, remote === 'failed' ? 'failed' : 'remote_cancelled', remote === 'failed' ? 'REMOTE_FAILED' : 'REMOTE_CANCELLED', 'poll', { remote_state: remote, raw_status: raw, completed_at: iso(), pause_reason: null, next_poll_at: null }); return;
                }
                const next = now() + rules.intervalMs;
                update(id, remote === 'queued' ? 'remote_queued' : 'generating', { remote_state: remote, raw_status: raw, ...(typeof outcome.progress==='number' && Number.isFinite(outcome.progress) && outcome.progress>=0 && outcome.progress<=100 ? {remote_progress:outcome.progress}:{}), poll_attempts: 0, poll_budget_started_at: null, next_poll_at: iso(next), not_before_at: null, task_error_json: null, error: null });
                schedule(id, next);
            } catch (error) {
                if (!closed && REMOTE_ACTIVE.has(row(id)?.status)) pollFailure(id, error);
            }
        })();
        inFlight.set(id, promise);
        try { await promise; } finally { inFlight.delete(id); if (!closed) background(pump()); }
    }
    function action(id, name, input = {}) {
        if (closed) throw fail('TASK_SERVICE_PAUSED', '任务服务已停止，现有记录保留。', 503);
        const task = row(id); if (!task) throw fail('TASK_NOT_FOUND', '找不到任务。', 404);
        if (!input || Object.keys(input).some(key => name !== 'attach-upstream-id' || key !== 'upstreamTaskId')) throw fail('INVALID_TASK_ACTION');
        if (name === 'cancel-queued') {
            if (!['local_queued', 'polling_paused'].includes(task.status) || task.dispatch_started_at || task.upstream_task_id) throw fail('TASK_ALREADY_DISPATCHED', '任务已开始派发，不能取消本地排队。', 409);
            update(id, 'local_cancelled', { completed_at: iso(), requires_continue: 0 }, 'queue_cancelled');
        } else if (name === 'continue-queued') {
            if (task.status !== 'local_queued' || task.dispatch_started_at) throw fail('TASK_ACTION_INVALID', '该任务不能继续排队。', 409);
            connections.getAuth(task.connection_version_id);
            update(id, 'local_queued', { requires_continue: 0 }, 'queue_continued'); background(pump());
        } else if (name === 'stop-polling') {
            if (!REMOTE_ACTIVE.has(task.status) || !task.upstream_task_id) throw fail('TASK_ACTION_INVALID', '该任务当前没有进行查询。', 409);
            pause(id, 'user_stopped');
        } else if (name === 'resume-polling') {
            if (task.status !== 'polling_paused' || !task.upstream_task_id) throw fail('TASK_ACTION_INVALID', '只有保留上游标识的暂停任务可以恢复查询。', 409);
            if (!isQueryableUpstreamTaskId(task.upstream_task_id)) throw fail('INVALID_UPSTREAM_ID', '原上游标识无法安全查询，任务保持暂停。', 409);
            if (inFlight.has(id)) throw fail('TASK_QUERY_BUSY', '原查询尚未结束，请稍后恢复。', 409);
            const earliest = Date.parse(task.not_before_at || '') || 0;
            if (earliest > now()) throw Object.assign(fail('POLL_NOT_BEFORE', '尚未到上游允许的查询时间。', 409), { notBeforeAt: task.not_before_at });
            connections.getAuth(task.connection_version_id); adapter(task);
            update(id, 'remote_queued', { pause_reason: null, error: null, task_error_json: null, poll_attempts: 0, poll_budget_started_at: null, next_poll_at: iso(), not_before_at: null }, 'polling_resumed'); schedule(id, now());
        } else if (name === 'attach-upstream-id') {
            if (task.status !== 'submission_unknown' || task.upstream_task_id) throw fail('TASK_ACTION_INVALID', '该任务不需要补充上游标识。', 409);
            const auth = connections.getAuth(task.connection_version_id), value = input.upstreamTaskId;
            if (!isQueryableUpstreamTaskId(value) || containsCredential(value, auth.apiKey)) throw fail('INVALID_UPSTREAM_ID');
            update(id, 'polling_paused', { upstream_task_id: value, pause_reason: 'reconciled_id', error: null, task_error_json: null }, 'submission_reconciled');
        } else if (name === 'retry-download') {
            if (task.status !== 'download_failed') throw fail('TASK_ACTION_INVALID', '该任务没有待重试的下载。', 409);
            if (!task.result_sources_json) throw fail('RESULT_REFRESH_REQUIRED', '需要由原适配器刷新结果地址；不会重新生成。', 409);
            update(id, 'remote_completed', { task_error_json: null, error: null }, 'download_retry_requested');
            db.prepare("UPDATE task_downloads SET state='waiting',updated_at=? WHERE task_id=?").run(iso(), id); background(drainDownloads());
        } else throw fail('TASK_ACTION_INVALID');
        emit(id); return publicTask(row(id));
    }
    function publicTask(task) {
        if (!task) return null;
        return { localTaskId: task.id, id: task.id, localRequestId: task.local_request_id, status: task.status,
            mode: task.mode, connectionVersionId: task.connection_version_id, upstreamTaskId: task.upstream_task_id,
            remoteState: task.remote_state, rawStatus: task.raw_status, progress: task.remote_progress ?? undefined, pauseReason: task.pause_reason,
            notBeforeAt: task.not_before_at, nextPollAt: task.next_poll_at, requiresContinue: Boolean(task.requires_continue),
            generationReserved: RESERVING.has(task.status) && Boolean(task.dispatch_started_at || task.upstream_task_id),
            remoteMayContinue: ['submission_unknown', 'polling_paused'].includes(task.status) && Boolean(task.dispatch_started_at || task.upstream_task_id),
            schedulingNotice: ['submission_unknown', 'polling_paused'].includes(task.status) && (task.dispatch_started_at || task.upstream_task_id) ? '远端可能仍在生成或计费；本地保留生成占位，后续队列等待同一任务的明确结果。' : null,
            taskError: task.task_error_json ? JSON.parse(task.task_error_json) : null, error: task.error,
            createdAt: task.created_at, completedAt: task.completed_at, expiresAt: null,
            inputAssets: store.taskAssets(task.id), outputAssets: store.taskAssets(task.id, 'output') };
    }
    async function drainDownloads() {
        if (closed || !downloadWorker || downloadsRunning >= 1) return;
        const job = db.prepare("SELECT * FROM task_downloads WHERE state='waiting' ORDER BY created_at,task_id LIMIT 1").get();
        if (!job) return;
        downloadsRunning++;
        const promise = (async () => {
            update(job.task_id, 'downloading'); db.prepare("UPDATE task_downloads SET state='running',updated_at=? WHERE task_id=?").run(iso(), job.task_id);
            try {
                // T08 must return an independently verifiable proof; no caller can merely set completed.
                const proof = await downloadWorker(row(job.task_id), JSON.parse(row(job.task_id).result_sources_json));
                if (!proof?.assetIds?.length) throw fail('DOWNLOAD_FAILED');
                for (const id of proof.assetIds) { const checked = store.readAsset(id); if (checked.asset.validationState !== 'verified') throw fail('DOWNLOAD_FAILED'); }
                if (closed) return;
                db.transaction(() => { store.bindTaskAssets(job.task_id, proof.assetIds.map((assetId, position) => ({ assetId, position, role: 'reference' })), 'output'); update(job.task_id, 'completed', { completed_at: iso() }); db.prepare("UPDATE task_downloads SET state='completed',updated_at=? WHERE task_id=?").run(iso(), job.task_id); })();
            } catch {
                if (!closed) { setError(job.task_id, 'download_failed', 'DOWNLOAD_FAILED', 'download'); db.prepare("UPDATE task_downloads SET state='failed',updated_at=? WHERE task_id=?").run(iso(), job.task_id); }
            }
        })();
        inFlight.set('download:' + job.task_id, promise);
        try { await promise; } finally { downloadsRunning--; inFlight.delete('download:' + job.task_id); if (!closed) background(drainDownloads()); }
    }
    function recover() {
        db.transaction(() => {
            for (const task of db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all()) {
                if (TERMINAL.has(task.status)) continue;
                if (['queued', '排队中', 'local_queued'].includes(task.status) && !task.dispatch_started_at && !task.upstream_task_id) {
                    update(task.id, 'local_queued', { requires_continue: 1 }, 'recovery_queue_waiting'); continue;
                }
                if (['remote_completed', 'downloading', 'download_failed'].includes(task.status)) {
                    if (task.status === 'downloading') update(task.id, 'remote_completed', {}, 'recovery_download_waiting');
                    db.prepare("UPDATE task_downloads SET state=CASE WHEN state='running' THEN 'waiting' ELSE state END,updated_at=? WHERE task_id=?").run(iso(), task.id); continue;
                }
                if (task.status === 'polling_paused') continue;
                const legacy = JSON.parse(task.request_json || '{}');
                const id = task.upstream_task_id || (typeof legacy.upstreamTaskId === 'string' ? legacy.upstreamTaskId : null);
                if (id && !isQueryableUpstreamTaskId(id)) {
                    setError(task.id, 'polling_paused', 'REMOTE_STATUS_UNKNOWN', 'poll', { pause_reason: 'upstream_id_unqueryable', upstream_task_id: id, next_poll_at: null });
                } else if (id) {
                    update(task.id, 'remote_queued', { upstream_task_id: id, remote_state: 'queued', next_poll_at: task.next_poll_at || iso(), requires_continue: 0 }, 'recovery_poll_only');
                } else setError(task.id, 'submission_unknown', 'SUBMISSION_UNKNOWN', 'submit', { pause_reason: 'restart_after_dispatch', dispatch_started_at: task.dispatch_started_at || task.created_at }, { transmission: 'may_have_reached_upstream' });
            }
        })();
        for (const task of db.prepare("SELECT * FROM tasks WHERE status IN ('remote_queued','generating')").all()) schedule(task.id, Math.max(Date.parse(task.next_poll_at || '') || now(), Date.parse(task.not_before_at || '') || 0));
        background(drainDownloads());
    }
    function stats() {
        const counts = Object.fromEntries(db.prepare('SELECT status,count(*) AS n FROM tasks GROUP BY status').all().map(item => [item.status, item.n]));
        const processing = [...RESERVING].reduce((sum, state) => sum + (counts[state] || 0), 0), queued = counts.local_queued || 0;
        return { concurrencyLimit: 1, configuredConcurrency: 1, processingCount: processing, queuedCount: queued, pendingCount: processing + queued,
            displayConcurrency: Math.min(1, processing), displayQueued: queued, downloadConcurrency: 1, downloadsRunning, schedulerError, acceptingNewTasks:!closed && !schedulerError,
            downloadQueued: db.prepare("SELECT count(*) AS n FROM task_downloads WHERE state='waiting'").get().n, pausedCount: counts.polling_paused || 0,
            awaitingContinueCount: db.prepare("SELECT count(*) AS n FROM tasks WHERE status='local_queued' AND requires_continue=1").get().n };
    }
    async function close() { closed = true; for (const controller of controllers) controller.abort(); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); await Promise.allSettled([...inFlight.values()]); }
    return { enqueue, findDuplicate, action, recover, stats, close, get: id => publicTask(row(id)), poll, pump, drainDownloads };
}
module.exports = { createTaskService, canonical, retryAfter, DEFAULT_POLICY, STATES };
