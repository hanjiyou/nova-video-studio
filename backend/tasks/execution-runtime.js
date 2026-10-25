'use strict';
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const ended = () => Object.assign(new Error('Local execution has ended'), { code: 'TASK_EXECUTION_ENDED' });
/** Logical executions outlive individual requests. Real IO is tracked separately by the service. */
function createExecutionRuntime({ now, monotonic = now === Date.now ? () => performance.now() : now,
    setTimer = setTimeout, clearTimer = clearTimeout, current, expire, phase, onError }) {
    const active = new Map();
    function start(task, downloadAttempt = null) {
        const previous = active.get(task.id);
        if (previous) return previous;
        const deadline = downloadAttempt?.deadline_at || task.execution_deadline_at;
        const started = downloadAttempt?.started_at || task.dispatch_started_at;
        const budget = (downloadAttempt?.timeout_seconds ?? task.execution_timeout_seconds ?? (Date.parse(deadline)-Date.parse(started))/1000) * 1000;
        const wallRemaining = deadline ? Date.parse(deadline) - now() : Infinity;
        // A clock before persisted dispatch is anomalous. Never grant another full budget.
        const remaining = deadline && (!Number.isFinite(wallRemaining) || now() < Date.parse(started) || wallRemaining > budget) ? 0 : wallRemaining;
        const startedMonotonic = monotonic();
        const ctx = { id: task.id, elapsedMs: () => Math.max(0,Math.floor(monotonic()-startedMonotonic)), token: downloadAttempt?.id || task.execution_attempt_id || randomUUID(),
            downloadAttempt, controller: new AbortController(), timer: null, due: monotonic() + remaining };
        active.set(task.id, ctx);
        ctx.remainingMs = () => Math.max(0, ctx.due - monotonic());
        ctx.checkpoint = () => {
            if (active.get(task.id) !== ctx || ctx.controller.signal.aborted || !current(task.id, ctx)) throw ended();
            if (ctx.remainingMs() <= 0) { expire(task.id, ctx); throw ended(); }
        };
        ctx.phase = value => { ctx.checkpoint(); phase(task.id, value, ctx); ctx.checkpoint(); };
        ctx.options = { signal: ctx.controller.signal, checkpoint: ctx.checkpoint, phase: ctx.phase, remainingMs: ctx.remainingMs, deadlineAt: deadline };
        function deadlineCheck() {
            try {
                if (active.get(task.id) !== ctx) return;
                if (ctx.remainingMs() <= 0) { expire(task.id, ctx); return; }
                ctx.timer = setTimer(deadlineCheck, Math.min(ctx.remainingMs(), 2147483647)); ctx.timer.unref?.();
            } catch(error) { onError(error); }
        }
        if (Number.isFinite(remaining)) { ctx.timer = setTimer(deadlineCheck, Math.max(0, Math.min(remaining, 2147483647))); ctx.timer.unref?.(); }
        return ctx;
    }
    function finish(id) { const ctx = active.get(id); if (!ctx) return; active.delete(id); clearTimer(ctx.timer); ctx.controller.abort(); }
    return { active, start, finish, close() { for (const id of active.keys()) finish(id); } };
}
module.exports = { createExecutionRuntime };
