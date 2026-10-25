'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto'), Database = require('better-sqlite3');
const { start } = require('./support/desktop-http-runtime.cjs');
const { migrateDatabase } = require('../storage/migrations'), { createWorkbenchStore } = require('../storage/store');
const { seedCapabilities, listCapabilities, generationEvidenceVerified } = require('../connections/capabilities');
const boundary = require('../tasks/workbench-input'), policy = require('../tasks/image-policy'), image = require('../tasks/flare-image-adapter');
const { compatibleImageVersion, replaySnapshot } = require('../tasks/plugin-compatibility');
const { buildRequestInit } = require('../plugin-runtime/request-body');
const base = policy.POLICY.baseUrl, model = policy.POLICY.model, key = 'synthetic-image-controls-only';
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1', name));
const prompt = '  编辑中文\n“完整对白”\r\n保持原图  ';
function cleanup(directory) {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
}
async function until(fn) { const end = Date.now() + 15000; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 20)); } throw Error('Synthetic image timeout'); }
const scope = (caps, mode) => caps.find(c => c.mode === mode && c.evidenceVersion === policy.POLICY.evidenceVersion);
async function rig(t, respond) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-controls-')), calls = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        calls.push({ method: req.method, path: req.url, type: req.headers['content-type'], authorization: req.headers.authorization, bytes: Buffer.concat(chunks) });
        if (respond) return respond(req, res, calls);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: fixture('reference-a.png').toString('base64') }] }));
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const options = { opensosenOrigin: 'http://127.0.0.1:' + upstream.address().port };
    let runtime = await start(directory, options);
    assert.equal((await runtime.request('/api/nova/storage/settings/taskExecution',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value:{imageConcurrency:1,videoConcurrency:1,imageTimeoutSeconds:120,videoTimeoutSeconds:300},expectedRevision:0})})).status,200);
    t.after(async () => { await runtime.stop(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); cleanup(directory); });
    const connection = await runtime.saveConnection({ baseUrl: base, apiKey: key });
    const models = await (await runtime.request('/api/nova/connections/' + connection.connectionId + '/models')).json(), assets = [];
    for (const name of ['reference-a.png', 'reference-single.jpg']) {
        const response = await runtime.request('/api/nova/assets/import', { method: 'POST', headers: { 'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg' }, body: fixture(name) });
        assert.equal(response.status, 201); assets.push((await response.json()).asset);
    }
    const input = (mode = 'image.reference', parameters = {}, index = 0) => ({ localRequestId: randomUUID(), connectionVersionId: connection.connectionVersionId,
        capabilityVersionId: (mode === 'image.text' && !Object.keys(parameters).length ? models.capabilities.find(c => c.mode === mode && c.isCurrent) : scope(models.capabilities, mode)).capabilityVersionId,
        mode, model, prompt, parameters, inputAssets: mode === 'image.text' ? [] : [{ assetId: assets[index].assetId, position: 0, role: 'reference' }] });
    return { directory, calls, models, assets, input, get runtime() { return runtime; },
        post: (route, body = {}) => runtime.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        task: id => runtime.request('/api/nova/tasks/' + id).then(r => r.json()),
        async restart() { await runtime.stop(); runtime = await start(directory, options); },
        async stop() { await runtime.stop(); }, async start() { runtime = await start(directory, options); } };
}

test('precise image scopes are immutable unverified options; minimum stays current and other services receive no grant', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-policy-')), db = new Database(path.join(directory, 'tasks.sqlite'));
    await migrateDatabase({ db, dbPath: db.name }); t.after(() => { db.close(); cleanup(directory); });
    seedCapabilities(db, 'opensosen', base); const caps = listCapabilities(db, 'opensosen', base), rows = db.prepare('SELECT * FROM model_capabilities ORDER BY id').all();
    seedCapabilities(db, 'opensosen', base); assert.deepEqual(db.prepare('SELECT * FROM model_capabilities ORDER BY id').all(), rows);
    const auth = { connectionVersionId: randomUUID(), provider: 'opensosen', baseUrl: base, protocol: 'openai', apiKey: key };
    const minimum = caps.find(c => c.mode === 'image.text' && c.isCurrent);
    assert.equal(minimum.evidenceLevel, 'application_verified'); assert.deepEqual(minimum.parameters, {});
    for (const mode of ['image.text', 'image.reference']) {
        const cap = scope(caps, mode), body = { localRequestId: randomUUID(), connectionVersionId: auth.connectionVersionId, capabilityVersionId: cap.capabilityVersionId,
            mode, model, prompt, parameters: mode === 'image.text' ? { size: '1024x1024' } : {}, inputAssets: mode === 'image.text' ? [] : [{ assetId: randomUUID(), role: 'reference', position: 0 }] };
        const snapshot = boundary.snapshotFor(body, '1.1.0'), row = boundary.validateCapability(db, snapshot, auth);
        assert.equal(cap.evidenceLevel, 'unverified'); assert.equal(generationEvidenceVerified(row), false);
        assert.throws(() => db.prepare('DELETE FROM model_capabilities WHERE id=?').run(cap.capabilityVersionId), /IMMUTABLE/);
        for (const change of [{ provider: 'openai-compatible' }, { baseUrl: 'https://other.invalid/v1' }, { protocol: 'other' }]) assert.throws(() => boundary.validateCapability(db, snapshot, { ...auth, ...change }), { code: 'CAPABILITY_UNVERIFIED' });
        assert.throws(() => boundary.validateCapability(db, { ...snapshot, adapterVersion: '1.0.0' }, auth), { code: 'CAPABILITY_UNVERIFIED' });
        if (mode === 'image.text') assert.throws(() => boundary.validateCapability(db, { ...snapshot, parameters: {} }, auth), { code: 'CAPABILITY_UNVERIFIED' });
        for (const parameters of [{ size: 'auto' }, { quality: 'auto' }, { size: '1448x1086' }, { quality: 'ultra' }, { quality: 1 }, { n: 2 }, { style: 'natural' }, { aspectRatio: '16:9' }, { size: '1024x1024', endpoint: '/edits' }]) assert.throws(() => boundary.snapshotFor({ ...body, parameters }, '1.1.0'), { code: 'INPUT_INVALID' });
        assert.throws(() => boundary.snapshotFor({ ...body, baseUrl: base }, '1.1.0'), { code: 'INPUT_INVALID' });
        if (mode === 'image.reference') for (const refs of [[], [body.inputAssets[0], { ...body.inputAssets[0], position: 1 }], [{ ...body.inputAssets[0], position: 1 }], [{ ...body.inputAssets[0], filePath: 'private.png' }]]) assert.throws(() => boundary.snapshotFor({ ...body, inputAssets: refs }, '1.1.0'), { code: 'INPUT_INVALID' });
    }
    for (const [provider, url] of [['openai-compatible', base], ['opensosen', 'https://other.invalid/v1']]) { seedCapabilities(db, provider, url); assert.ok(!listCapabilities(db, provider, url).some(c => c.evidenceVersion === policy.POLICY.evidenceVersion)); }
});

test('all supported sizes and qualities build explicit JSON without changing the minimum request', () => {
    const auth = { provider: 'opensosen', baseUrl: base, protocol: 'openai', connectionVersionId: randomUUID(), apiKey: key };
    const snapshot = { mode: 'image.text', model, prompt, inputAssets: [], parameters: {} };
    assert.deepEqual(image.buildSubmit(snapshot, auth).json, { model, prompt, n: 1 });
    for (const size of policy.POLICY.sizes) for (const quality of policy.POLICY.qualities) assert.deepEqual(image.buildSubmit({ ...snapshot, parameters: { size, quality } }, auth).json, { model, prompt, n: 1, size, quality });
    assert.throws(() => image.buildSubmit({ ...snapshot, parameters: { quality: 'auto' } }, auth), { code: 'INPUT_INVALID' });
});

test('ordinary intent submits minimum, explicit text, and original PNG/JPEG single-image multipart once each with local verified results', async t => {
    const f = await rig(t), bodies = [f.input('image.text'), f.input('image.text', { size: '1536x1024', quality: 'max' }), f.input('image.reference', { size: '1024x1536', quality: 'xhigh' }), f.input('image.reference', {}, 1)];
    for (const body of bodies) {
        const prepared = await f.post('/api/nova/storage/submissions', body); assert.equal(prepared.status, 201); const frozen = (await prepared.json()).input;
        const response = await f.post('/api/nova/workbench/tasks', frozen); assert.equal(response.status, 202); const id = (await response.json()).taskId;
        assert.equal((await (await f.post('/api/nova/workbench/tasks', frozen)).json()).taskId, id);
        const completed = await until(async () => { const task = await f.task(id); return task.status === 'completed' && task; });
        assert.equal(completed.outputAssets[0].validationState, 'verified'); assert.equal(completed.upstreamTaskId, null);
        assert.equal(completed.outputAssets[0].sha256, f.assets[0].sha256);
    }
    const posts = f.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 4);
    assert.deepEqual(JSON.parse(posts[0].bytes), { model, prompt, n: 1 }); assert.deepEqual(JSON.parse(posts[1].bytes), { model, prompt, n: 1, size: '1536x1024', quality: 'max' });
    for (let index = 2; index < 4; index++) {
        const call = posts[index]; assert.equal(call.path, '/v1/images/edits'); assert.match(call.type, /^multipart\/form-data; boundary=/); assert.equal(call.authorization, 'Bearer ' + key);
        const form = await new Response(call.bytes, { headers: { 'content-type': call.type } }).formData();
        assert.deepEqual([...form.keys()], index === 2 ? ['model','prompt','n','size','quality','image'] : ['model','prompt','n','image']);
        assert.equal(form.get('model'), model); assert.equal(form.get('prompt'), prompt.replace(/\r?\n/g, '\r\n')); assert.equal(form.get('n'), '1');
        assert.equal(form.getAll('image').length, 1); const file = form.get('image'); assert.equal(file.type, f.assets[index - 2].mimeType);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), fixture(index === 2 ? 'reference-a.png' : 'reference-single.jpg'));
    }
    const before = f.calls.length; await f.restart(); assert.equal(f.calls.length, before);
    const db = new Database(path.join(f.directory, 'tasks.sqlite'), { readonly: true });
    for (const body of bodies) { const task = db.prepare('SELECT * FROM tasks WHERE local_request_id=?').get(body.localRequestId); assert.equal(task.adapter_version, '1.1.0'); assert.equal(db.prepare('SELECT evidence_level FROM model_capabilities WHERE id=?').get(task.capability_version_id).evidence_level, body === bodies[0] ? 'application_verified' : 'unverified'); }
    db.close();
    const body = bodies[2];
    for (const change of [{ model: 'gpt-image-2.5-sunburst' }, { parameters: { quality: 'auto' } }, { inputAssets: [] }, { parameters: { size: '1024x1024', n: 2 } }, { capabilityVersionId: bodies[0].capabilityVersionId }]) assert.equal((await f.post('/api/nova/workbench/tasks', { ...body, ...change, localRequestId: randomUUID() })).status, 400);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 4);
});

test('edit file resolution rejects manual boundaries, spoofed types and foreign assets before any request', () => {
    const asset = { assetId: randomUUID(), kind: 'image', mimeType: 'image/png' }, bytes = fixture('reference-a.png');
    const auth = { provider: 'opensosen', baseUrl: base, protocol: 'openai', apiKey: key, connectionVersionId: randomUUID() }, snapshot = { mode: 'image.reference', model, prompt, parameters: {}, inputAssets: [{ assetId: asset.assetId, role: 'reference', position: 0 }] };
    const request = image.buildSubmit(snapshot, auth, () => asset), context = { ...auth, inputAssets: snapshot.inputAssets }, read = () => ({ asset, bytes });
    assert.ok(buildRequestInit(request, context, read).body instanceof FormData);
    for (const change of [{ headers: { 'content-type': 'multipart/form-data; boundary=manual' } }, { parts: [{ ...request.parts.at(-1), assetId: randomUUID() }] }, { parts: [{ ...request.parts.at(-1), mimeType: 'image/jpeg' }] }]) assert.throws(() => buildRequestInit({ ...request, ...change }, context, read), { code: 'INPUT_INVALID' });
    assert.throws(() => buildRequestInit(request, context, () => ({ asset, bytes: Buffer.from('corrupt') })), { code: 'INPUT_INVALID' });
    assert.throws(() => image.buildSubmit(snapshot, auth, () => ({ ...asset, mimeType: 'image/webp' })), { code: 'INPUT_INVALID' });
});

test('edit preflight catches a missing or changed original before the dispatch boundary', () => {
    const asset = { assetId: randomUUID(), kind: 'image', mimeType: 'image/png' }, auth = { provider: 'opensosen', baseUrl: base, protocol: 'openai', connectionVersionId: randomUUID(), apiKey: key };
    const snapshot = { mode: 'image.reference', model, prompt, parameters: {}, inputAssets: [{ assetId: asset.assetId, position: 0, role: 'reference' }] };
    const options = { getAsset: () => asset, validateCapability: () => {} };
    assert.throws(() => image.createFlareImageAdapter({ ...options, readAsset: () => { throw Object.assign(Error('missing'), { code: 'ASSET_MISSING' }); } }).preflight({}, snapshot, auth), { code: 'ASSET_MISSING' });
    assert.throws(() => image.createFlareImageAdapter({ ...options, readAsset: () => ({ asset, bytes: Buffer.from('changed') }) }).preflight({}, snapshot, auth), { code: 'INPUT_INVALID' });
});

for (const failure of ['empty', 'server-error', 'connection-lost']) test('edit ' + failure + ' ends unrecoverable local wait across restart while retaining unknown remote outcome and never resending', async t => {
    const f = await rig(t, (req, res) => { if (failure === 'connection-lost') return req.socket.destroy(); res.writeHead(failure === 'server-error' ? 503 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(failure === 'empty' ? { data: [] } : { error: { message: 'synthetic temporary rejection' } })); });
    const body = f.input(), response = await f.post('/api/nova/workbench/tasks', body); assert.equal(response.status, 202); const id = (await response.json()).taskId;
    await until(async () => (await f.task(id)).status === 'submission_unknown');
    const queued = (await (await f.post('/api/nova/workbench/tasks', f.input())).json()).taskId;
    await f.restart(); const task = await f.task(id); assert.equal(task.status, 'failed'); assert.equal(task.generationReserved, false);assert.equal(task.remoteOutcome,'unknown'); assert.equal(task.upstreamTaskId, null);
    assert.equal((await f.task(queued)).status, 'local_queued');assert.equal((await f.task(queued)).requiresContinue,true); assert.equal((await (await f.post('/api/nova/workbench/tasks', body)).json()).taskId, id);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/v1/images/edits');
});

test('explicit edit rejection is safe and single-attempt; URL results and corrupt output retain existing validation semantics', async t => {
    let next = 'reject'; const f = await rig(t, (req, res) => {
        if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fixture('reference-a.png')); }
        res.writeHead(next === 'reject' ? 400 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next === 'reject' ? { error: { message: 'unsupported synthetic quality' } } : next === 'url' ? { data: [{ url: base + '/result.png' }] } : { data: [{ b64_json: fixture('reference-a.png').subarray(0, 20).toString('base64') }] }));
    });
    for (const [mode, status] of [['reject','failed'], ['url','completed'], ['corrupt','download_failed']]) {
        next = mode; const body = f.input('image.reference', { quality: 'max' }), response = await f.post('/api/nova/workbench/tasks', body), id = (await response.json()).taskId;
        const task = await until(async () => { const task = await f.task(id); return task.status === status && task; });
        if (mode === 'reject') { assert.equal(task.taskError.code, 'REMOTE_REJECTED'); assert.equal(task.taskError.httpStatus, 400); assert.equal(task.generationReserved, false); }
        if (mode === 'url') assert.equal(task.outputAssets[0].validationState, 'verified');
        if (mode === 'corrupt') { assert.equal(task.outputAssets.length, 0); assert.equal(task.taskError.phase, 'media'); }
    }
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 3); assert.equal(f.calls.filter(c => c.method === 'GET').length, 1);
});

test('1.0 minimum image recovery preserves saved snapshots; same old local ID returns original task and differing inputs conflict', async t => {
    const f = await rig(t), body = f.input('image.text'); await f.stop();
    const db = new Database(path.join(f.directory, 'tasks.sqlite')), store = createWorkbenchStore({ db, rootDirectory: path.join(f.directory, 'storage') });
    const snapshot = { ...boundary.snapshotFor(body, '1.1.0'), adapterVersion: '1.0.0', outputDirectoryVersionId: '00000000-0000-4000-8000-000000000001', outputRootRef: '00000000-0000-4000-8000-000000000001' }, id = randomUUID();
    db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,requires_continue) VALUES(?,?,?,?,?,1)').run(id, 'local_queued', body.mode, JSON.stringify({ mode: body.mode, model, fields: { prompt } }), new Date().toISOString()); store.setTaskSnapshot(id, snapshot);
    const saved = db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id).input_snapshot_json; db.close();
    const taskRow = { adapter_id: 'opensosen-flare-image', adapter_version: '1.0.0', mode: 'image.text', input_snapshot_json: saved };
    assert.equal(compatibleImageVersion(taskRow), '1.0.0'); assert.equal(compatibleImageVersion({ ...taskRow, adapter_version: '2.0.0' }), null);
    assert.equal(compatibleImageVersion({ ...taskRow, input_snapshot_json: JSON.stringify({ ...snapshot, parameters: { quality: 'high' } }) }), null);
    assert.equal(replaySnapshot(boundary.snapshotFor(body, '1.1.0'), snapshot).adapterVersion, '1.0.0');
    await f.start(); assert.equal((await f.task(id)).requiresContinue, true); assert.equal(f.calls.length, 0);
    assert.equal((await (await f.post('/api/nova/workbench/tasks', body)).json()).taskId, id);
    assert.equal((await f.post('/api/nova/workbench/tasks', { ...body, prompt: 'changed' })).status, 409);
    assert.equal(f.calls.length, 0); assert.equal((await f.post('/api/nova/tasks/' + id + '/continue-queued')).status, 200);
    await until(async () => (await f.task(id)).status === 'completed'); assert.equal(f.calls.length, 1); assert.deepEqual(JSON.parse(f.calls[0].bytes), { model, prompt, n: 1 });
    await f.restart(); assert.equal((await (await f.post('/api/nova/workbench/tasks', body)).json()).taskId, id); assert.equal(f.calls.length, 1);
    const after = new Database(path.join(f.directory, 'tasks.sqlite'), { readonly: true }); const row = after.prepare('SELECT input_snapshot_json,adapter_version FROM tasks WHERE id=?').get(id);
    assert.equal(row.input_snapshot_json, saved); assert.equal(row.adapter_version, '1.0.0'); after.close();
});
