'use strict';
const { isQueryableUpstreamTaskId, encodeUpstreamTaskId } = require('../../plugin-runtime/upstream-id');
const { controlledVideoTextValidation } = require('../../tasks/controlled-video-text-validation');
const BASE_URL = 'https://newapi.opensosen.com/v1';
const MODELS = ['grok-imagine-video-6s', 'grok-imagine-video-1.5-6s'];
function failure(code) { return Object.assign(new Error(code === 'CAPABILITY_UNVERIFIED' ? '当前服务、模型与模式组合缺少协议证据。' : '视频输入无效。'), { code, statusCode: 400 }); }
function validate(context) {
    const counts = { 'video.text': 0, 'video.single_reference': 1, 'video.dual_reference': 2 };
    const input = context.inputAssets;
    if (!MODELS.includes(context.model) || !Object.hasOwn(counts, context.mode) || typeof context.fields?.prompt !== 'string' ||
        !context.fields.prompt.trim() || !Array.isArray(input) || input.length !== counts[context.mode] ||
        input.some((item, index) => item.position !== index || item.role !== 'reference')) throw failure('INPUT_INVALID');
    if (context.baseUrl !== BASE_URL || context.model !== MODELS[1] || (context.mode === 'video.text' && !controlledVideoTextValidation.isAuthorizedContext(context))) throw failure('CAPABILITY_UNVERIFIED');
    if (!context.connectionVersionId) throw failure('INPUT_INVALID');
    const parameters = context.parameters;
    const withoutSize = controlledVideoTextValidation.candidateFor(context) === 'without-size';
    if (!parameters || parameters.seconds !== 6 || (withoutSize ? Object.keys(parameters).length !== 1 :
        parameters.size !== '1280x720' || Object.keys(parameters).some(key => !['seconds', 'size'].includes(key)))) throw failure('INPUT_INVALID');
    if (input.some(item => !['image/png', 'image/jpeg'].includes(item.mimeType))) throw failure('INPUT_INVALID');
}
/** Descriptors contain references only; the host appends original files in this exact order. */
function buildSubmit(context) {
    validate(context);
    const parts = [
        { kind: 'field', name: 'model', value: context.model },
        { kind: 'field', name: 'prompt', value: context.fields.prompt },
        { kind: 'field', name: 'seconds', value: '6' },
        ...(controlledVideoTextValidation.candidateFor(context) === 'without-size' ? [] : [{ kind: 'field', name: 'size', value: '1280x720' }]),
        ...context.inputAssets.map((item, index) => ({ kind: 'file', name: 'input_reference', assetId: item.assetId,
            fileName: 'reference-' + (index + 1) + (item.mimeType === 'image/png' ? '.png' : '.jpg'), mimeType: item.mimeType })),
    ];
    return { method: 'POST', url: context.baseUrl + '/videos', encoding: 'multipart', parts, auth: { connectionVersionId: context.connectionVersionId } };
}
function extractAcceptedId(payload) {
    // H01/H02 are top-level bodies. Do not invent additional envelopes or coercions.
    return typeof payload?.task_id === 'string' && payload.task_id.trim() ? payload.task_id :
        typeof payload?.id === 'string' && payload.id.trim() ? payload.id : undefined;
}
function parseSubmitResponse(payload) {
    const upstreamTaskId = extractAcceptedId(payload);
    if (!isQueryableUpstreamTaskId(upstreamTaskId)) throw failure('SUBMISSION_UNKNOWN');
    if (payload.id !== undefined && payload.task_id !== undefined && payload.id !== payload.task_id) throw failure('SUBMISSION_UNKNOWN');
    return { upstreamTaskId };
}
function buildQuery(upstreamTaskId, context) {
    if (context.baseUrl !== BASE_URL || !MODELS.includes(context.model)) throw failure('CAPABILITY_UNVERIFIED');
    return { method: 'GET', url: context.baseUrl + '/videos/' + encodeUpstreamTaskId(upstreamTaskId), auth: { connectionVersionId: context.connectionVersionId } };
}
function parseTaskResult(payload, context) {
    const rawStatus = typeof payload?.status === 'string' ? payload.status : '';
    const state = ({ queued: 'queued', in_progress: 'processing', completed: 'completed', failed: 'failed', cancelled: 'cancelled' })[rawStatus] || 'unknown';
    const progress = typeof payload?.progress === 'number' && Number.isFinite(payload.progress) && payload.progress >= 0 && payload.progress <= 100 ? payload.progress : undefined;
    // H02 + historical read-only downloader prove /content. Prefer a stable same-origin source
    // over persisting the transient/CDN URL fields; T08 still owns download/auth/media checks.
    const assets = state === 'completed' ? [{ kind: 'video', url: context.baseUrl + '/videos/' + encodeUpstreamTaskId(context.upstreamTaskId) + '/content' }] : [];
    return { state, rawStatus, progress, assets };
}
module.exports = { buildSubmit, extractAcceptedId, parseSubmitResponse, buildQuery, parseTaskResult, MODELS };
