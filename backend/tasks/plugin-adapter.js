'use strict';
const { resolveTemplate } = require('../plugin-runtime/template');
const { pickFirstString, extractProgress, normalizeResult } = require('../plugin-runtime/extract');
const executor = require('../plugin-runtime/executor');
const { containsCredential } = require('../connections/redaction');
function failure(code, fields = {}) { return Object.assign(new Error(code), { code, ...fields }); }
function credentialFree(value, key) {
    if (containsCredential(typeof value === 'string' ? value : JSON.stringify(value), key)) throw failure('RESPONSE_CREDENTIAL_REDACTED', { credentialRedacted: true });
}
function contextFor(plugin, task, auth) {
    const request = JSON.parse(task.request_json);
    return executor.buildContext({ ...request, ...auth, plugin, upstreamTaskId: task.upstream_task_id });
}
function sources(assets, context) {
    return (assets || []).map(asset => ({ kind: 'url', url: asset.url, mediaKind: asset.kind, authScope: context && new URL(asset.url).origin === new URL(context.baseUrl).origin ? 'connection' : 'none' }));
}
function createPluginAdapter(plugin) {
    function checkMethod(method, expected) { if (String(method).toUpperCase() !== expected) throw failure('ADAPTER_UNAVAILABLE'); }
    async function build(context, polling) {
        let request;
        if (plugin.driver) request = polling ? await plugin.driver.buildQuery(context.upstreamTaskId, context) : await plugin.driver.buildSubmit(context);
        else {
            const spec = polling ? plugin.provider.poll : plugin.provider.submit;
            if (polling) context = { ...context, upstreamTaskId: encodeURIComponent(context.upstreamTaskId) };
            request = { url: resolveTemplate(spec.url, context), method: spec.method || (polling ? 'GET' : 'POST'), headers: resolveTemplate(spec.headers || {}, context), body: spec.body === undefined ? undefined : resolveTemplate(spec.body, context) };
        }
        if (!request?.url) throw failure('ADAPTER_UNAVAILABLE');
        checkMethod(request.method || (polling ? 'GET' : 'POST'), polling ? 'GET' : 'POST');
        const url = executor.assertUrlAllowed(plugin, request.url, polling ? '查询请求' : '创建请求');
        if (new URL(url).origin !== new URL(context.baseUrl).origin || containsCredential(url, context.apiKey)) throw failure('ADAPTER_UNAVAILABLE');
        const headers = { ...(request.headers || {}) };
        const init = { method: polling ? 'GET' : 'POST', headers, redirect: 'manual' };
        if (!polling && request.body !== undefined) {
            init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
            if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
        }
        return { url, init };
    }
    async function send(context, polling) {
        const request = await build(context, polling), controller = new AbortController();
        const timeout = Math.min(90000, Math.max(1000, Number(plugin.manifest.runtime?.[polling ? 'pollTimeoutMs' : 'submitTimeoutMs']) || (polling ? 15000 : 90000)));
        const timer = setTimeout(() => controller.abort(), timeout);
        const abort = () => controller.abort();
        context.signal?.addEventListener('abort', abort, { once: true });
        if (context.signal?.aborted) controller.abort();
        try {
            const response = await fetch(request.url, { ...request.init, signal: controller.signal });
            const text = await response.text(); // timeout covers headers AND body
            let payload;
            try { payload = JSON.parse(text); } catch { throw failure(polling ? (response.ok ? 'REMOTE_STATUS_UNKNOWN' : 'POLL_TRANSIENT') : 'SUBMISSION_UNKNOWN', {httpStatus:response.status,retryAfter:response.headers.get('retry-after')}); }
            const extracted = plugin.driver ? undefined : pickFirstString(payload, plugin.provider.submit.extract.taskId);
            if (!polling && extracted && !containsCredential(extracted,context.apiKey)) context.onAccepted?.(extracted);
            try { credentialFree(text, context.apiKey); credentialFree(payload, context.apiKey); } catch (error) { error.httpStatus=response.status; throw error; }
            // A usable accepted ID wins over an HTTP error. Never discard a task already created.
            if (!response.ok && !(extracted && !polling)) throw failure(polling ? 'POLL_TRANSIENT' : 'SUBMISSION_UNKNOWN', {
                httpStatus: response.status, retryAfter: response.headers.get('retry-after'), transmission: 'response_received',
                definiteRejection: !polling && response.status >= 400 && response.status < 500 && Boolean(payload?.error || payload?.message || payload?.msg),
            });
            return payload;
        } finally { clearTimeout(timer); context.signal?.removeEventListener('abort', abort); }
    }
    return {
        id: 'plugin:' + plugin.id, version: plugin.manifest.version,
        async preflight(task, _snapshot, auth) { await build(contextFor(plugin, task, auth), false); },
        async submit(task, _snapshot, auth) {
            const context = { ...contextFor(plugin, task, auth), signal: auth.signal, onAccepted:auth.onAccepted }, payload = await send(context, false);
            let accepted;
            if (plugin.driver?.parseSubmitResponse) {
                const parsed = await plugin.driver.parseSubmitResponse(payload, context);
                accepted = typeof parsed === 'string' ? { upstreamTaskId: parsed } : { upstreamTaskId: parsed?.upstreamTaskId || parsed?.taskId, immediate: parsed?.immediate };
            } else accepted = { upstreamTaskId: pickFirstString(payload, plugin.provider.submit.extract.taskId) };
            credentialFree(accepted, auth.apiKey);
            if (accepted.upstreamTaskId) auth.onAccepted?.(accepted.upstreamTaskId);
            if (!plugin.driver && accepted.upstreamTaskId) {
                const status=pickFirstString(payload,plugin.provider.poll.status?.from || ['status','state']) || '';
                if (plugin.provider.poll.status?.completed?.includes(status.toLowerCase())) accepted.immediate=normalizeResult(payload,plugin.provider.poll.result,{...context,upstreamTaskId:encodeURIComponent(accepted.upstreamTaskId)},resolveTemplate);
            }
            if (!accepted.upstreamTaskId && !accepted.immediate?.assets?.length) throw failure('SUBMISSION_UNKNOWN');
            return { upstreamTaskId: accepted.upstreamTaskId, ...(accepted.immediate?.assets?.length ? { resultSources: sources(accepted.immediate.assets, context) } : {}) };
        },
        async poll(task, _snapshot, auth) {
            const context = { ...contextFor(plugin, task, auth), signal: auth.signal }, payload = await send(context, true);
            if (plugin.driver?.parseTaskResult) {
                const parsed = await plugin.driver.parseTaskResult(payload, context); credentialFree(parsed, auth.apiKey);
                return { remoteState: ({ processing: 'generating', queued: 'queued', completed: 'completed', failed: 'failed', cancelled: 'cancelled' })[parsed?.state] || 'unknown', rawStatus: parsed?.rawStatus || parsed?.state, resultSources: sources(parsed?.assets, context) };
            }
            const spec = plugin.provider.poll, raw = pickFirstString(payload, spec.status?.from || ['status', 'state']) || '';
            const normalized = spec.status?.lowercase === false ? raw : raw.toLowerCase();
            const remoteState = [['completed', 'completed'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['queued', 'queued'], ['processing', 'generating']].find(([bucket]) => Array.isArray(spec.status?.[bucket]) && spec.status[bucket].includes(normalized))?.[1] || 'unknown';
            return { remoteState, rawStatus: raw, progress: extractProgress(payload, spec.progress), ...(remoteState === 'completed' ? { resultSources: sources(normalizeResult(payload, spec.result, {...context,upstreamTaskId:encodeURIComponent(context.upstreamTaskId)}, resolveTemplate).assets, context) } : {}) };
        },
    };
}
module.exports = { createPluginAdapter, failure };
