'use strict';
// I01 data contract. Admission, cancellation, deadline enforcement and recovery
// remain the responsibility of I02-I04; these defaults do not enable concurrency.
const MODES = Object.freeze({
    'image.text': 'image', 'image.reference': 'image',
    'video.text': 'video', 'video.single_reference': 'video',
    'video.dual_reference': 'video', 'video.multi_reference': 'video',
});
const LEGACY_MODES = Object.freeze({ 'text-to-image': 'image', 'image-to-image': 'image', 'plugin': 'video', 'legacy.plugin': 'video' });
const EXECUTION_LIMITS = Object.freeze({ concurrency: Object.freeze({ min: 1, max: 5 }), timeoutSeconds: Object.freeze({ min: 30, max: 1800 }) });
const DEFAULT_EXECUTION_SETTINGS = Object.freeze({ imageConcurrency: 3, videoConcurrency: 3, imageTimeoutSeconds: 120, videoTimeoutSeconds: 300, imageDownloadTimeoutSeconds: 30, videoDownloadTimeoutSeconds: 180 });
const LOCAL_OUTCOMES = Object.freeze(['completed', 'failed', 'timed_out', 'cancelled']);
const REMOTE_OUTCOMES = Object.freeze(['not_dispatched', 'unknown', 'confirmed_result', 'confirmed_rejected', 'confirmed_failed', 'confirmed_cancelled']);
const EXECUTION_PHASES = Object.freeze(['reference_upload', 'submitting', 'receiving', 'parsing', 'remote_waiting', 'downloading', 'validating', 'saving']);
const RESERVING = new Set(['submitting', 'submission_unknown', 'remote_queued', 'generating', 'polling_paused', 'remote_completed', 'downloading']);
function mediaKind(mode) { return Object.hasOwn(MODES, mode) ? MODES[mode] : Object.hasOwn(LEGACY_MODES, mode) ? LEGACY_MODES[mode] : null; }
function validateExecutionSettings(value) {
    const invalid = () => Object.assign(new Error('任务设置必须是范围内的整数。'), { code: 'INVALID_SETTING_VALUE', statusCode: 400 });
    const keys = Object.keys(DEFAULT_EXECUTION_SETTINGS);
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
    for (const key of keys) {
        const range = key.endsWith('Concurrency') ? EXECUTION_LIMITS.concurrency : EXECUTION_LIMITS.timeoutSeconds;
        if (!Number.isInteger(value[key]) || value[key] < range.min || value[key] > range.max) throw invalid();
    }
    return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function normalizeExecutionSettings(value, previous = DEFAULT_EXECUTION_SETTINGS) {
    const legacyKeys = ['imageConcurrency','videoConcurrency','imageTimeoutSeconds','videoTimeoutSeconds'];
    if (value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 4 && legacyKeys.every(key => Object.hasOwn(value,key))) {
        return validateExecutionSettings({...value,imageDownloadTimeoutSeconds:previous.imageDownloadTimeoutSeconds,videoDownloadTimeoutSeconds:previous.videoDownloadTimeoutSeconds});
    }
    return validateExecutionSettings(value);
}
function executionSnapshot(mode, settings) {
    const kind = mediaKind(mode);
    if (!kind) throw Object.assign(new Error('无法识别任务媒体类型。'), { code: 'INVALID_TASK_MODE', statusCode: 400 });
    const checked = normalizeExecutionSettings(settings);
    return { mediaKind: kind, timeoutSeconds: checked[kind + 'TimeoutSeconds'] };
}
function localOutcome(task) {
    if (task.local_outcome) return task.local_outcome;
    const known = { completed: 'completed', failed: 'failed', download_failed: 'failed', local_cancelled: 'cancelled', remote_cancelled: 'cancelled', timed_out: 'timed_out', cancelled: 'cancelled' };
    return Object.hasOwn(known, task.status) ? known[task.status] : null;
}
function remoteOutcome(task) {
    if (task.remote_outcome) return task.remote_outcome;
    const known = { completed: 'confirmed_result', failed: 'confirmed_failed', cancelled: 'confirmed_cancelled' };
    if (Object.hasOwn(known, task.remote_state)) return known[task.remote_state];
    let error;
    try { error = JSON.parse(task.task_error_json || 'null'); } catch { /* Legacy malformed metadata proves no remote outcome. */ }
    if (['REMOTE_REJECTED','MODEL_UNAVAILABLE'].includes(error?.code) || error?.transmission === 'response_received' && error?.code === 'AUTH_REJECTED' && task.status === 'failed') return 'confirmed_rejected';
    if (!task.dispatch_started_at && !task.upstream_task_id && (['local_queued','local_cancelled'].includes(task.status) || error?.transmission === 'not_dispatched')) return 'not_dispatched';
    return 'unknown';
}
function taskFields(task, snapshot = {}, downloadAttempt = null) {
    const outcome = localOutcome(task), remote = remoteOutcome(task);
    let error = null;
    try { error = JSON.parse(task.task_error_json || 'null'); } catch { /* Keep unreadable legacy metadata readable. */ }
    const dispatched = Boolean(task.dispatch_started_at || task.upstream_task_id);
    // One media slot covers submission, remote waiting, download, validation and save.
    const retryActive = Boolean(downloadAttempt && downloadAttempt.outcome === null);
    const reserved = retryActive || !outcome && RESERVING.has(task.status) && dispatched;
    const mayContinue = dispatched && remote === 'unknown' && (Boolean(outcome) || ['submission_unknown', 'polling_paused'].includes(task.status));
    return {
        id: task.id, localTaskId: task.id, localRequestId: task.local_request_id, status: task.status,
        mode: snapshot.mode || task.mode, mediaKind: task.execution_media_kind || mediaKind(snapshot.mode || task.mode),
        connectionVersionId: task.connection_version_id, upstreamTaskId: task.upstream_task_id,
        outputDirectoryVersionId: task.output_directory_version_id, outputRootRef: task.output_root_ref,
        remoteState: task.remote_state, rawStatus: task.raw_status, progress: task.remote_progress ?? undefined,
        pauseReason: task.pause_reason, notBeforeAt: task.not_before_at, nextPollAt: task.next_poll_at,
        requiresContinue: Boolean(task.requires_continue), generationReserved: reserved, remoteMayContinue: mayContinue,
        localExecutionActive: retryActive || !outcome,
        schedulingNotice: mayContinue ? (reserved ? '远端可能仍在生成或计费；本地等待受原截止时间约束，可取消本地等待。' : '已停止本地等待；远端结果待核对，可能仍在生成或计费。') : null,
        localOutcome: outcome, remoteOutcome: remote,
        lifecycleVersion: task.lifecycle_version ?? 1, generationOutcome: task.generation_outcome ?? null, generationFinishedAt: task.generation_finished_at ?? null,
        executionAttemptId: task.execution_attempt_id ?? null, timeoutSeconds: task.execution_timeout_seconds ?? null,
        dispatchStartedAt: task.dispatch_started_at ?? null, deadlineAt: task.execution_deadline_at ?? null,
        localFinishedAt: task.local_finished_at ?? (outcome ? task.completed_at ?? null : null),
        phase: task.execution_phase ?? null, phaseStartedAt: task.execution_phase_started_at ?? null,
        // Legacy tasks.error is arbitrary upstream text; never expand its exposure to history.
        taskError: error, error: typeof error?.message === 'string' ? error.message : null,
        createdAt: task.created_at, completedAt: task.completed_at, expiresAt: null,
    };
}
module.exports = { MODES, EXECUTION_LIMITS, DEFAULT_EXECUTION_SETTINGS, LOCAL_OUTCOMES, REMOTE_OUTCOMES, EXECUTION_PHASES, mediaKind, localOutcome, remoteOutcome, validateExecutionSettings, normalizeExecutionSettings, executionSnapshot, taskFields };
