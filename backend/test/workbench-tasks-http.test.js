'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { start } = require('./support/desktop-http-runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(15); } throw new Error('Synthetic HTTP scenario timed out'); }
async function rig(t, behavior = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-t05-http-')), calls = [], held = [];
    const server = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
        const configured = req.method === 'POST' ? behavior.submit : behavior.poll;
        const response = typeof configured === 'function' ? configured(req, calls) : configured;
        const data = response || (req.method === 'POST' ? { body: { id: 'synthetic-remote-A', status: 'queued' } } : { body: { status: 'generating', progress: 37 } });
        const finish = () => { if (res.destroyed) return; res.writeHead(data.status || 200, { 'content-type': 'application/json', ...data.headers }); res.end(JSON.stringify(data.body)); };
        if (data.hold) held.push(finish); else finish();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const pluginOrigin = 'http://127.0.0.1:' + server.address().port;
    let runtime = await start(directory, { pluginOrigin });
    t.after(async () => { held.splice(0).forEach(fn => fn()); await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); const actual = path.resolve(directory); assert.ok(actual.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    const connection = await runtime.saveConnection({ baseUrl: 'https://pro.ccode.vip/v1', apiKey: 'synthetic-http-A' });
    const input = (extra = {}) => ({ localRequestId: randomUUID(), connectionVersionId: connection.connectionVersionId, pluginId: 'ccode-h3', facets: { tier: 'standard', resolution: '768P' }, fields: { mode: 'multi-reference', aspectRatio: '9:16', seconds: 8, prompt: '  中文\n"完整台词"\r\n第二行  ' }, media: {}, ...extra });
    const post = (route, body = {}) => runtime.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const create = async body => { const result = await post('/api/nova/plugin-tasks', body || input()); assert.equal(result.status, 202, JSON.stringify(await result.clone().json())); return (await result.json()).taskId; };
    const task = async id => (await runtime.request('/api/nova/tasks/' + id)).json();
    const inspect = fn => { const db = new Database(path.join(directory, 'tasks.sqlite')); try { return fn(db); } finally { db.close(); } };
    return { directory, calls, connection, input, post, create, task, inspect, get runtime() { return runtime; }, release() { held.splice(0).forEach(fn => fn()); },
        async crashRestart() { const exit = await runtime.crash(); assert.ok(exit.code !== 0 || exit.signal); inspect(db => db.prepare("UPDATE tasks SET next_poll_at='2000-01-01T00:00:00Z' WHERE status IN ('generating','remote_queued')").run()); runtime = await start(directory, { pluginOrigin }); t.diagnostic('Forced process exit ' + JSON.stringify(exit) + '; restart uses a new loopback port and the same isolated SQLite profile.'); } };
}
test('actual desktop HTTP persists dispatch, deduplicates a lost ACK, survives forced exit with no ID, and never automatically POSTs the waiting queue', async t => {
    const f = await rig(t, { submit: { hold: true, body: { id: 'not-delivered-A' } } });
    const original = f.input(), [id, same] = await Promise.all([f.create(original), f.create(original)]); assert.equal(id, same);
    await until(() => f.calls.length === 1); assert.equal(f.calls[0].method, 'POST'); assert.equal(JSON.parse(f.calls[0].body).prompt, original.fields.prompt);
    const queued = await f.create(), conflict = await f.post('/api/nova/plugin-tasks', { ...original, fields: { ...original.fields, prompt: 'changed' } }); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'LOCAL_REQUEST_CONFLICT');
    const persisted = f.inspect(db => db.prepare('SELECT status,dispatch_started_at,upstream_task_id,input_snapshot_json FROM tasks WHERE id=?').get(id)); assert.equal(persisted.status, 'submitting'); assert.ok(persisted.dispatch_started_at); assert.equal(persisted.upstream_task_id, null);
    await f.crashRestart(); assert.equal((await f.task(id)).status, 'submission_unknown'); assert.equal((await f.task(queued)).requiresContinue, true); assert.equal((await f.task(id)).generationReserved, true);
    await f.post('/api/nova/tasks/' + queued + '/continue-queued'); await pause(50); assert.equal(f.calls.length, 1);
    assert.equal(await f.create(original), id); assert.equal(f.calls.length, 1);
    assert.equal((await f.post('/api/nova/tasks/' + id + '/cancel-queued')).status, 409);
    assert.equal((await f.post('/api/nova/tasks/' + queued + '/cancel-queued')).status, 200); assert.equal((await f.task(queued)).status, 'local_cancelled');
    assert.equal((await fetch(f.runtime.origin + '/api/nova/tasks/' + id + '/attach-upstream-id', { method: 'POST' })).status, 403);
    assert.equal((await f.post('/api/nova/tasks/' + id + '/attach-upstream-id', { upstreamTaskId: 'known/A?part#opaque' })).status, 200); assert.equal(f.calls.length, 1);
    assert.equal((await f.post('/api/nova/tasks/' + id + '/resume-polling')).status, 200);
    await until(() => f.calls.length === 2); assert.equal(f.calls[1].method, 'GET'); assert.equal(f.calls[1].path, '/v1/videos/known%2FA%3Fpart%23opaque');
    assert.equal(f.calls[1].authorization, 'Bearer synthetic-http-A'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
test('actual process exits after upstream ID persistence and during GET recover only the original GET, with immutable connection and conservative pause reservation', async t => {
    const behavior = { poll: { hold: true, body: { status: 'generating', progress: 37 } } }, f = await rig(t, behavior);
    const id = await f.create(); await until(async () => (await f.task(id)).status === 'remote_queued');
    assert.equal(f.inspect(db => db.prepare('SELECT upstream_task_id FROM tasks WHERE id=?').get(id).upstream_task_id), 'synthetic-remote-A');
    await f.crashRestart(); await until(() => f.calls.some(call => call.method === 'GET')); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    await f.crashRestart(); await until(() => f.calls.filter(call => call.method === 'GET').length === 2); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    const newer = await f.runtime.saveConnection({ connectionId: f.connection.connectionId, expectedVersionId: f.connection.connectionVersionId, baseUrl: 'https://pro.ccode.vip/v1', apiKey: 'synthetic-http-B' }); assert.notEqual(newer.connectionVersionId, f.connection.connectionVersionId);
    const stopped = await f.post('/api/nova/tasks/' + id + '/stop-polling'); assert.equal(stopped.status, 200); assert.equal((await stopped.json()).task.remoteMayContinue, true);
    const queued = await f.create(); f.release(); await pause(50); assert.equal((await f.task(id)).status, 'polling_paused'); assert.equal((await f.task(queued)).status, 'local_queued'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    behavior.poll = { body: { status: 'failed', error: { message: 'synthetic confirmed remote conclusion' } } };
    assert.equal((await f.post('/api/nova/tasks/' + id + '/resume-polling')).status, 200); await until(async () => (await f.task(id)).status === 'failed');
    await until(() => f.calls.filter(call => call.method === 'POST').length === 2); assert.ok(f.calls.every(call => call.authorization === 'Bearer synthetic-http-A'));
    assert.equal((await f.task(id)).upstreamTaskId, 'synthetic-remote-A'); assert.equal((await f.task(id)).connectionVersionId, f.connection.connectionVersionId);
});
for (const response of [
    { name: '401', status: 401, body: { error: 'synthetic authentication rejection' }, code: 'AUTH_REJECTED' },
    { name: '429 with long Retry-After', status: 429, headers: { 'retry-after': '180' }, body: { error: 'synthetic throttling' }, code: 'RATE_LIMITED' },
    { name: 'unknown status', body: { status: 'NEW_PENDING_STATE' }, code: 'REMOTE_STATUS_UNKNOWN' },
]) test('actual HTTP GET ' + response.name + ' pauses, preserves ID, blocks queued POST and does not become remote failure', async t => {
    const f = await rig(t, { poll: response }), id = await f.create(); await until(async () => (await f.task(id)).status === 'remote_queued'); await f.crashRestart();
    const paused = await until(async () => { const task = await f.task(id); return task.status === 'polling_paused' ? task : null; }); assert.equal(paused.taskError.code, response.code); assert.equal(paused.upstreamTaskId, 'synthetic-remote-A');
    await f.create(); await pause(50); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    if (response.status === 429) { const resumed = await f.post('/api/nova/tasks/' + id + '/resume-polling'); assert.equal(resumed.status, 409); assert.equal((await resumed.json()).notBeforeAt, paused.notBeforeAt); }
    if (response.name === 'unknown status') assert.equal(paused.rawStatus, 'NEW_PENDING_STATE');
    const history = await (await f.runtime.request('/api/nova/storage/tasks')).json(); assert.equal(JSON.stringify(history).includes('synthetic-http-A'), false); assert.equal(f.runtime.output().includes('synthetic-http-A'), false);
});
test('actual remote completion persists a download job and candidate but exposes neither a remote URL nor a completed local work', async t => {
    const f = await rig(t, { poll: { body: { status: 'completed', progress: 100, video_url: 'https://cdn.invalid/synthetic.mp4' } } }), id = await f.create(); await until(async () => (await f.task(id)).status === 'remote_queued'); await f.crashRestart();
    await until(async () => (await f.task(id)).status === 'remote_completed');
    const task = await f.task(id); assert.equal(task.outputAssets.length, 0); assert.equal(task.completedAt, null); assert.equal(JSON.stringify(task).includes('cdn.invalid'), false);
    assert.equal(f.inspect(db => db.prepare('SELECT state FROM task_downloads WHERE task_id=?').get(id).state), 'waiting');
    await f.crashRestart(); assert.equal((await f.task(id)).status, 'remote_completed'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.calls.filter(call => call.method === 'GET').length, 1);
});
