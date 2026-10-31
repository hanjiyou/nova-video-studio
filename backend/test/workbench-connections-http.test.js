'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const {randomUUID}=require('node:crypto');
const Database = require('better-sqlite3');
const { start } = require('./support/desktop-http-runtime.cjs');
const { PRESET_MODELS } = require('../connections/capabilities');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
        const result = await fn();
        if (result)
            return result;
        await delay(25);
    }
    throw new Error('Timed out');
}
async function upstream() {
    const calls = [], held = [];
    let hold = true;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, bytes: Buffer.concat(chunks) });
        if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: PRESET_MODELS.map(id => ({ id })) }));
            return;
        }
        const finish = () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Synthetic rejection ' + req.headers.authorization } })); };
        if (hold) {
            hold = false;
            held.push(finish);
        }
        else
            finish();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', calls, release() { held.splice(0).forEach(fn => fn()); }, async close() { held.splice(0).forEach(fn => fn()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const payload = connectionVersionId => ({ localRequestId:randomUUID(), connectionVersionId, mode: 'text-to-image', model: 'gpt-image-2', prompt: '中文\n"完整台词"', parallelCount: 1, outputSize: 'auto', aspectRatio: 'auto', images: [] });
const post = (runtime, route, body) => runtime.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const task = async (runtime, id) => (await runtime.request('/api/nova/tasks/' + id)).json();
async function serialQueue(runtime) { assert.equal((await runtime.request('/api/nova/storage/settings/taskExecution',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value:{imageConcurrency:1,videoConcurrency:1,imageTimeoutSeconds:120,videoTimeoutSeconds:300},expectedRevision:0})})).status,200); }
function cleanup(directory) { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
test('actual HTTP model GET/cache and queued tasks use immutable version A after current connection changes to B; HTTP/WS/history contain no keys', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-connections-http-')), a = await upstream(), b = await upstream();
    let runtime = await start(directory), socket;
    await serialQueue(runtime);
    const keyA = 'synthetic-http-key-A', keyB = 'synthetic-http-key-B';
    t.after(async () => { a.release(); b.release(); socket?.close(); await runtime.stop(); await a.close(); await b.close(); cleanup(directory); });
    const first = await runtime.saveConnection({ displayName: '共享图像视频连接', baseUrl: a.baseUrl, apiKey: keyA });
    assert.equal((await fetch(runtime.origin + '/api/nova/connections')).status, 403);
    assert.equal((await runtime.request('/api/nova/connections/' + first.connectionId + '/check')).status, 405);
    assert.equal((await post(runtime, '/api/nova/connections', { displayName: 'HTTP save is forbidden' })).status, 405);
    assert.equal((await post(runtime, '/api/nova/tasks', { ...payload(first.connectionVersionId), apiKey: 'raw-key-must-reject' })).status, 400);
    assert.equal((await post(runtime, '/api/nova/tasks', { ...payload(first.connectionVersionId), baseUrl: b.baseUrl })).status, 400);
    assert.equal((await post(runtime, '/api/nova/proxy/models', { connectionVersionId: first.connectionVersionId })).status, 400);
    const checked = await (await post(runtime, '/api/nova/connections/' + first.connectionId + '/check', { connectionVersionId: first.connectionVersionId })).json();
    assert.equal(checked.connection.validationState, 'verified');
    assert.ok(PRESET_MODELS.every(id => checked.models.find(model => model.model === id)?.visibility === 'visible'));
    assert.ok(checked.capabilities.every(cap => cap.evidenceLevel === 'unverified'));
    await post(runtime, '/api/nova/connections/' + first.connectionId + '/check', { connectionVersionId: first.connectionVersionId });
    assert.equal(a.calls.length, 1);
    assert.equal(a.calls[0].method, 'GET');
    assert.equal(a.calls[0].path, '/v1/models');
    assert.equal(a.calls[0].authorization, 'Bearer ' + keyA);
    const events = [];
    socket = runtime.openWebSocket();
    socket.on('message', data => events.push(data.toString()));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const blocker = await post(runtime, '/api/nova/tasks', payload(first.connectionVersionId));
    assert.equal(blocker.status, 202);
    const blockerId = (await blocker.json()).taskId;
    await until(() => a.calls.some(call => call.method === 'POST'));
    const queued = await post(runtime, '/api/nova/tasks', payload(first.connectionVersionId));
    assert.equal(queued.status, 202);
    const queuedId = (await queued.json()).taskId;
    assert.equal((await task(runtime, queuedId)).status, 'local_queued');
    const next = await runtime.saveConnection({ connectionId: first.connectionId, expectedVersionId: first.connectionVersionId, baseUrl: b.baseUrl, apiKey: keyB, defaultImageModel: 'exact-selected-model' });
    a.release();
    await until(async () => (await task(runtime, queuedId)).status === 'failed');
    assert.equal(a.calls.filter(call => call.method === 'POST').length, 2);
    assert.equal(b.calls.length, 0);
    assert.ok(a.calls.every(call => call.authorization === 'Bearer ' + keyA));
    const responses = [checked, await task(runtime, blockerId), await task(runtime, queuedId), await (await runtime.request('/api/nova/connections')).json(), await (await runtime.request('/api/nova/storage/tasks')).json(), await (await runtime.request('/api/nova/storage/tasks/' + queuedId + '/events')).json()];
    for (const key of [keyA, keyB]) {
        assert.equal(JSON.stringify(responses).includes(key), false);
        assert.equal(events.join('\n').includes(key), false);
        assert.equal(runtime.output().includes(key), false);
    }
    const inspection = new Database(path.join(directory, 'tasks.sqlite'), { readonly: true });
    const stored = inspection.prepare('SELECT connection_version_id,input_snapshot_json,request_json FROM tasks WHERE id=?').get(queuedId);
    assert.equal(stored.connection_version_id, first.connectionVersionId);
    assert.equal(JSON.parse(stored.input_snapshot_json).connectionVersionId, first.connectionVersionId);
    assert.notEqual(stored.connection_version_id, next.connectionVersionId);
    assert.equal(stored.request_json.includes(keyA), false);
    inspection.close();
    socket.close();
    await runtime.stop();
    const count = a.calls.length;
    runtime = await start(directory);
    assert.equal(a.calls.length, count, 'restart does not create or check automatically');
    assert.equal((await (await runtime.request('/api/nova/connections/current')).json()).connection.connectionVersionId, next.connectionVersionId);
    const old = await post(runtime, '/api/nova/tasks', payload(first.connectionVersionId));
    assert.equal(old.status, 202);
    const oldId = (await old.json()).taskId;
    await until(async () => (await task(runtime, oldId)).status === 'failed');
    assert.equal(a.calls.at(-1).authorization, 'Bearer ' + keyA);
    assert.equal(b.calls.length, 0);
    await runtime.stop();
    for (const key of [keyA, keyB])
        assert.equal(fs.readFileSync(path.join(directory, 'tasks.sqlite')).includes(Buffer.from(key)), false);
});
test('actual queued task loses credential access after clear, pauses without a POST and retains its immutable snapshot/shared input', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-connections-clear-')), a = await upstream(), runtime = await start(directory);
    t.after(async () => { a.release(); await runtime.stop(); await a.close(); cleanup(directory); });
    await serialQueue(runtime);
    const connection = await runtime.saveConnection({ baseUrl: a.baseUrl, apiKey: 'synthetic-clear-key' });
    const image = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1/reference-a.png'));
    const imported = await runtime.request('/api/nova/assets/import', { method: 'POST', headers: { 'content-type': 'image/png' }, body: image });
    const asset = (await imported.json()).asset;
    const blocker = await post(runtime, '/api/nova/tasks', payload(connection.connectionVersionId));
    assert.equal(blocker.status, 202);
    await until(() => a.calls.length === 1);
    const queued = await post(runtime, '/api/nova/tasks', { ...payload(connection.connectionVersionId), mode: 'image-to-image', images: [], inputAssets: [{ assetId: asset.assetId, role: 'reference', position: 0 }] });
    assert.equal(queued.status, 202);
    const queuedId = (await queued.json()).taskId;
    const cleared = await runtime.clearConnectionCredential({ connectionId: connection.connectionId, expectedVersionId: connection.connectionVersionId });
    assert.equal(cleared.hasCredential, false);
    a.release();
    await until(async () => (await task(runtime, queuedId)).status === 'polling_paused');
    assert.equal(a.calls.length, 1, 'cleared queued task never POSTs');
    assert.deepEqual(Buffer.from(await (await runtime.request(asset.previewUrl)).arrayBuffer()), image);
    const inspection = new Database(path.join(directory, 'tasks.sqlite'), { readonly: true });
    const row = inspection.prepare('SELECT connection_version_id,input_snapshot_json FROM tasks WHERE id=?').get(queuedId);
    assert.equal(row.connection_version_id, connection.connectionVersionId);
    assert.equal(JSON.parse(row.input_snapshot_json).inputAssets[0].assetId, asset.assetId);
    assert.equal(inspection.prepare("SELECT count(*) n FROM task_events WHERE task_id=? AND type='credential_access_paused'").get(queuedId).n, 1);
    inspection.close();
    const denied = await post(runtime, '/api/nova/tasks', payload(connection.connectionVersionId));
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).code, 'CREDENTIAL_REQUIRED');
    assert.equal(a.calls.length, 1);
});
test('actual image result URL containing the protected credential is rejected before any download or history disclosure', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-connection-result-'));
    let downloads = 0;
    const key = 'synthetic-result-key';
    const server = http.createServer(async (req, res) => { for await (const chunk of req) {
        void chunk;
    } if (req.method === 'GET')
        downloads++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ url: 'http://127.0.0.1:' + server.address().port + '/download?token=' + key }] })); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const runtime = await start(directory);
    t.after(async () => { await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cleanup(directory); });
    const connection = await runtime.saveConnection({ baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: key });
    const created = await post(runtime, '/api/nova/tasks', payload(connection.connectionVersionId));
    assert.equal(created.status, 202);
    const id = (await created.json()).taskId;
    const failed = await until(async () => { const row = await task(runtime, id); return row.status === 'download_failed' ? row : null; });
    assert.equal(downloads, 0);
    assert.equal(JSON.stringify(failed).includes(key), false);
    assert.ok(failed.error.includes('连接凭据'));
    assert.equal(JSON.stringify(await (await runtime.request('/api/nova/storage/tasks')).json()).includes(key), false);
    assert.equal(runtime.output().includes(key), false);
});

// Encode every byte, including unreserved ASCII that encodeURIComponent leaves intact.
const percentEncodeEveryByte = value => [...Buffer.from(value, 'utf8')].map(byte => '%' + byte.toString(16).padStart(2, '0').toUpperCase()).join('');
const credentialEchoCases = [
    { name: 'fully percent-encoded', depth: 1, prefix: '' },
    { name: 'twice fully percent-encoded', depth: 2, prefix: '' },
    { name: 'fully percent-encoded after malformed percent escapes', depth: 1, prefix: 'bad=%ZZ%FF ' },
    { name: 'twice fully percent-encoded after malformed percent escapes', depth: 2, prefix: 'bad=%ZZ%FF ' },
];
for (const example of credentialEchoCases)
    test('actual desktop HTTP image failure rejects ' + example.name + ' credential echoes before HTTP/WS/SQLite/history/log disclosure', async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-encoded-error-'));
        const key = 't04-key-A9', encoded = [key, percentEncodeEveryByte(key)];
        encoded.push(percentEncodeEveryByte(encoded[1]));
        let requests = 0;
        const server = http.createServer(async (req, res) => {
            for await (const chunk of req) void chunk;
            requests++;
            assert.equal(req.headers.authorization, 'Bearer ' + key);
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Known failure: ' + example.prefix + encoded[example.depth] } }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const runtime = await start(directory), events = [], socket = runtime.openWebSocket();
        t.after(async () => { socket.close(); await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cleanup(directory); });
        socket.on('message', data => events.push(data.toString()));
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        const connection = await runtime.saveConnection({ baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: key });
        const created = await post(runtime, '/api/nova/tasks', payload(connection.connectionVersionId));
        assert.equal(created.status, 202);
        const id = (await created.json()).taskId;
        socket.send(JSON.stringify({ type: 'subscribeTasks', taskIds: [id] }));
        const failed = await until(async () => { const row = await task(runtime, id); return row.status === 'failed' ? row : null; });
        await until(() => events.some(value => value.includes(id) && value.includes('failed')));
        const inspection = new Database(path.join(directory, 'tasks.sqlite'), { readonly: true });
        let persisted;
        try {
            persisted = {
                tasks: inspection.prepare('SELECT * FROM tasks WHERE id=?').all(id),
                taskItems: inspection.prepare('SELECT * FROM task_items WHERE task_id=?').all(id),
                taskEvents: inspection.prepare('SELECT * FROM task_events WHERE task_id=?').all(id),
            };
        } finally { inspection.close(); }
        const channels = {
            http: JSON.stringify(failed),
            websocket: events.join('\n'),
            sqliteTask: JSON.stringify(persisted.tasks),
            sqliteTaskItems: JSON.stringify(persisted.taskItems),
            sqliteTaskEvents: JSON.stringify(persisted.taskEvents),
            history: JSON.stringify(await (await runtime.request('/api/nova/storage/tasks')).json()),
            historyEvents: JSON.stringify(await (await runtime.request('/api/nova/storage/tasks/' + id + '/events')).json()),
            processLog: runtime.output(),
        };
        const leaks = Object.fromEntries(Object.entries(channels).map(([name, value]) => [name, encoded.some(secret => value.includes(secret) || value.includes(secret.toLowerCase()))]));
        t.diagnostic(JSON.stringify({ case: example.name, leakChannels: leaks }));
        assert.equal(requests, 1, 'exactly one loopback POST, without a paid/external request');
        assert.deepEqual(leaks, Object.fromEntries(Object.keys(channels).map(name => [name, false])));
        assert.match(failed.error, /连接凭据/);
    });

for (const depth of [1, 2])
    test('actual Web HTTP image failure preserves legacy upstream errors for percent-encoding depth ' + depth, async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-web-error-')), key = 't04-key-A9';
        let echo = key;
        for (let index = 0; index < depth; index++) echo = percentEncodeEveryByte(echo);
        const server = http.createServer(async (req, res) => {
            for await (const chunk of req) void chunk;
            assert.equal(req.headers.authorization, 'Bearer ' + key);
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Legacy failure: ' + echo } }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const runtime = await start(directory, { desktop: false });
        t.after(async () => { await runtime.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cleanup(directory); });
        const created = await post(runtime, '/api/nova/tasks', { ...payload(undefined), protocol: 'openai', apiKey: key, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' });
        assert.equal(created.status, 202);
        const id = (await created.json()).taskId;
        const failed = await until(async () => { const row = await task(runtime, id); return row.status === 'failed' ? row : null; });
        assert.ok(failed.error.includes('Legacy failure: ' + echo));
    });
