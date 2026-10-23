'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const { BASE_SCHEMA } = require('../storage/migrations');
const { start } = require('./support/desktop-http-runtime.cjs');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1', name));
async function until(fn, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) {
    const value = await fn();
    if (value)
        return value;
    await new Promise(resolve => setTimeout(resolve, 30));
} throw new Error('Timed out'); }

function seed(directory) {
    fs.mkdirSync(path.join(directory, 'images'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'plugin-media'), { recursive: true });
    const db = new Database(path.join(directory, 'tasks.sqlite'));
    db.exec(BASE_SCHEMA);
    const completed = randomUUID(), processing = randomUUID(), plugin = randomUUID();
    const insert = db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,expires_at) VALUES(?,?,?,?,?,?)');
    insert.run(completed, 'completed', 'text-to-image', JSON.stringify({ prompt: '历史中文\n"台词"', model: 'fixture' }), '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z');
    insert.run(processing, 'processing', 'image-to-image', JSON.stringify({ prompt: 'in progress', model: 'fixture' }), '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z');
    insert.run(plugin, 'failed', 'plugin', JSON.stringify({ pluginId: 'ccode-h3', model: 'fixture' }), '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z');
    fs.writeFileSync(path.join(directory, 'images', processing + '-0-0.png'), fixture('reference-a.png'));
    const file = randomUUID() + '.png';
    fs.writeFileSync(path.join(directory, 'plugin-media', file), fixture('reference-b.png'));
    fs.utimesSync(path.join(directory, 'plugin-media', file), new Date(0), new Date(0));
    db.prepare('INSERT INTO plugin_media(file_name,hash,kind,bytes,task_id,created_at) VALUES(?,?,?,?,?,?)').run(file, 'synthetic', 'images', fixture('reference-b.png').length, plugin, '2000-01-01T00:00:00Z');
    db.close();
    return { completed, processing, plugin, file };
}
test('actual desktop HTTP persists ordered assets/drafts/history across changed port and clean restart; ACK/failure never removes shared input', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-storage-http-'));
    const old = seed(directory);
    let runtime = await start(directory);
    let upstream;
    t.after(async () => { await runtime.stop(); if (upstream) {
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
    } assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    assert.equal((await fetch(runtime.origin + '/api/nova/storage/tasks')).status, 403);
    const oldTask = await (await runtime.request('/api/nova/tasks/' + old.completed)).json();
    assert.equal(oldTask.status, 'completed');
    assert.equal(oldTask.expiresAt, null);
    const processing = await (await runtime.request('/api/nova/tasks/' + old.processing)).json();
    assert.equal(processing.status, 'submission_unknown');
    assert.ok(fs.existsSync(path.join(directory, 'images', old.processing + '-0-0.png')));
    assert.ok(fs.existsSync(path.join(directory, 'plugin-media', old.file)));
    const assets = [];
    for (const name of ['reference-a.png', 'reference-b.png']) {
        const response = await runtime.request('/api/nova/assets/import', { method: 'POST', headers: { 'content-type': 'image/png', 'x-nova-filename': encodeURIComponent('中文 ' + name) }, body: fixture(name) });
        assert.equal(response.status, 201);
        assets.push((await response.json()).asset);
    }
    const refs = assets.map((asset, position) => ({ assetId: asset.assetId, position, role: 'reference' }));
    const prompt = '中文原文\n"这句台词"\r\n第二行';
    const save = await runtime.request('/api/nova/storage/drafts/video.dual_reference', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, model: 'fixture-video', parameters: { duration: 6, aspectRatio: '16:9' }, inputAssets: [{ ...refs[1], position: 0 }, { ...refs[0], position: 1 }], expectedRevision: 0 }) });
    assert.equal(save.status, 200);
    const secretRejected = await runtime.request('/api/nova/storage/drafts/image.text', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', model: 'fixture', parameters: { apiKey: 'synthetic-secret' }, inputAssets: [] }) });
    assert.equal(secretRejected.status, 400);
    assert.equal((await runtime.request('/api/nova/storage/settings/theme', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'dark', expectedRevision: 0 }) })).status, 200);
    const beforeQueue = new Database(path.join(directory, 'tasks.sqlite'));
    beforeQueue.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(old.processing); beforeQueue.close(); // explicit synthetic remote conclusion; not a production release action
    const posts = [];
    upstream = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req)
        chunks.push(chunk); posts.push(Buffer.concat(chunks)); if (posts.length > 2) {
        setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: fixture('reference-a.png').toString('base64') }] })); }, 100);
        return;
    } res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Synthetic image rejection' } })); });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const fixtureConnection = await runtime.saveConnection({baseUrl:'http://127.0.0.1:' + upstream.address().port,apiKey:'fixture-token'});
    const ids = [];
    for (const input of [[refs[1], refs[0]], [refs[0]]]) {
        const response = await runtime.request('/api/nova/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localRequestId:randomUUID(), connectionVersionId: fixtureConnection.connectionVersionId, mode: 'image-to-image', prompt: 'synthetic', model: 'gpt-image-2', parallelCount: 1, outputSize: 'auto', aspectRatio: 'auto', inputAssets: input.map((item, position) => ({ ...item, position })) }) });
        assert.equal(response.status, 202);
        const { taskId } = await response.json();
        ids.push(taskId);
        await until(async () => { const value = await (await runtime.request('/api/nova/tasks/' + taskId)).json(); return value.status === 'failed'; });
    }
    assert.equal(posts.length, 2);
    assert.ok(posts[0].indexOf(fixture('reference-b.png')) < posts[0].indexOf(fixture('reference-a.png')));
    const upload = await runtime.request('/api/nova/plugin-media?pluginId=ccode-h3&kind=images', { method: 'POST', headers: { 'content-type': 'image/png' }, body: fixture('reference-a.png') });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json();
    assert.equal(uploaded.assetId, assets[0].assetId);
    assert.deepEqual(Buffer.from(await (await runtime.request(new URL(uploaded.url).pathname)).arrayBuffer()), fixture('reference-a.png'));
    const success = await runtime.request('/api/nova/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localRequestId:randomUUID(), connectionVersionId: fixtureConnection.connectionVersionId, mode: 'text-to-image', prompt: 'synthetic output', model: 'gpt-image-2', parallelCount: 1, outputSize: 'auto', aspectRatio: 'auto', images: [] }) });
    assert.equal(success.status, 202);
    const outputId = (await success.json()).taskId;
    const unknown = path.join(directory, 'images', outputId + '-0-0.png');
    fs.writeFileSync(unknown, 'unknown pre-existing file');
    await until(async () => { const value = await (await runtime.request('/api/nova/tasks/' + outputId)).json(); return value.status === 'remote_completed'; });
    assert.equal(posts.length, 3);
    assert.equal(fs.readFileSync(unknown, 'utf8'), 'unknown pre-existing file');
    const candidateDb = new Database(path.join(directory, 'tasks.sqlite'), {readonly:true});
    const candidates=JSON.parse(candidateDb.prepare('SELECT result_sources_json FROM tasks WHERE id=?').get(outputId).result_sources_json);candidateDb.close();
    assert.equal(candidates[0].kind,'asset');
    assert.deepEqual(Buffer.from(await (await runtime.request('/api/nova/assets/'+candidates[0].assetId+'/content')).arrayBuffer()), fixture('reference-a.png'));
    assert.equal((await (await runtime.request('/api/nova/tasks/'+outputId)).json()).outputAssets.length,0); // candidate is not a verified local output
    const db = new Database(path.join(directory, 'tasks.sqlite'));
    const beforeAck = db.prepare('SELECT expires_at FROM tasks WHERE id=?').get(ids[0]).expires_at;
    const snapshot = JSON.parse(db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(ids[0]).input_snapshot_json);
    assert.deepEqual(snapshot.inputAssets.map(item => item.assetId), [assets[1].assetId, assets[0].assetId]);
    await runtime.request('/api/nova/tasks/' + ids[0] + '/ack', { method: 'POST' });
    await runtime.request('/api/nova/tasks/' + ids[0] + '/ack', { method: 'POST' });
    assert.equal(db.prepare('SELECT expires_at FROM tasks WHERE id=?').get(ids[0]).expires_at, beforeAck);
    assert.equal(db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id=? AND type='acknowledged'").get(ids[0]).n, 1);
    for (const id of ids)
        db.prepare('UPDATE tasks SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z', id);
    const backupCount = fs.readdirSync(path.join(directory, 'backups')).length;
    db.close();
    const firstOrigin = runtime.origin;
    await runtime.stop();
    runtime = await start(directory);
    assert.notEqual(runtime.origin, firstOrigin);
    assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, backupCount);
    const draft = (await (await runtime.request('/api/nova/storage/drafts/video.dual_reference')).json()).draft;
    assert.equal(draft.prompt, prompt);
    assert.deepEqual(draft.inputAssets.map(item => item.assetId), [assets[1].assetId, assets[0].assetId]);
    assert.equal((await (await runtime.request('/api/nova/storage/settings/theme')).json()).setting.value, 'dark');
    const history = await (await runtime.request('/api/nova/storage/tasks')).json();
    assert.equal(history.total, 6);
    assert.ok(history.items.some(item => item.localTaskId === old.completed));
    for (const id of ids)
        assert.equal((await (await runtime.request('/api/nova/tasks/' + id)).json()).status, 'failed');
    assert.deepEqual(Buffer.from(await (await runtime.request(assets[0].previewUrl)).arrayBuffer()), fixture('reference-a.png'));
    const events = await (await runtime.request('/api/nova/storage/tasks/' + ids[0] + '/events')).json();
    assert.ok(events.events.some(event => event.type === 'legacy_status_observed'));
    const inspection = new Database(path.join(directory, 'tasks.sqlite'));
    assert.equal(inspection.prepare("SELECT count(*) AS n FROM task_assets WHERE asset_id=? AND role='input'").get(assets[0].assetId).n, 2);
    assert.equal(JSON.stringify(inspection.prepare('SELECT input_snapshot_json FROM tasks WHERE input_snapshot_json IS NOT NULL').all()).includes('fixture-token'), false);
    inspection.close();
});

test('actual HTTP legacy images cannot forge asset identity; missing/corrupt authoritative references reject before upstream POST', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-storage-forgery-'));
    const runtime = await start(directory);
    const posts = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        posts.push(Buffer.concat(chunks));
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Synthetic image rejection' } }));
    });
    t.after(async () => {
        await runtime.stop();
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const fixtureConnection = await runtime.saveConnection({baseUrl:'http://127.0.0.1:' + upstream.address().port,apiKey:'fixture-token'});
    const originalBytes = fixture('reference-a.png');
    const actualBytes = fixture('reference-b.png');
    const imported = await runtime.request('/api/nova/assets/import', { method: 'POST', headers: { 'content-type': 'image/png' }, body: originalBytes });
    assert.equal(imported.status, 201);
    const original = (await imported.json()).asset;
    const payload = { connectionVersionId: fixtureConnection.connectionVersionId, mode: 'image-to-image', prompt: 'synthetic identity forgery', model: 'gpt-image-2', parallelCount: 1, outputSize: 'auto', aspectRatio: 'auto' };
    const submit = input => runtime.request('/api/nova/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, localRequestId:randomUUID(), ...input }) });
    const ids = [];
    const forged = async () => {
        const response = await submit({ images: [{ assetId: original.assetId, data: actualBytes.toString('base64'), mimeType: 'image/png' }] });
        assert.equal(response.status, 202);
        const { taskId } = await response.json();
        ids.push(taskId);
        await until(async () => (await (await runtime.request('/api/nova/tasks/' + taskId)).json()).status === 'failed');
        assert.equal(posts.length, ids.length);
        assert.ok(posts.at(-1).includes(actualBytes), 'upstream multipart contains bytes B');
        assert.equal(posts.at(-1).includes(originalBytes), false, 'upstream never uploads bytes A');
        const db = new Database(path.join(directory, 'tasks.sqlite'), { readonly: true });
        try {
            const task = db.prepare('SELECT input_snapshot_json,request_json FROM tasks WHERE id=?').get(taskId);
            const refs = JSON.parse(task.input_snapshot_json).inputAssets;
            assert.equal(refs.length, 1);
            assert.notEqual(refs[0].assetId, original.assetId);
            assert.deepEqual(JSON.parse(task.request_json).inputAssets, refs);
            const stored = db.prepare('SELECT sha256 FROM assets WHERE id=?').get(refs[0].assetId);
            assert.equal(stored.sha256, createHash('sha256').update(actualBytes).digest('hex'));
            assert.deepEqual(db.prepare("SELECT asset_id AS assetId FROM task_assets WHERE task_id=? AND role='input' ORDER BY position").all(taskId), [{ assetId: refs[0].assetId }]);
            assert.equal(db.prepare('SELECT sha256 FROM assets WHERE id=?').get(original.assetId).sha256, original.sha256);
            assert.deepEqual(Buffer.from(await (await runtime.request('/api/nova/assets/' + refs[0].assetId + '/content')).arrayBuffer()), actualBytes);
        }
        finally {
            db.close();
        }
    };
    await forged();
    assert.deepEqual(Buffer.from(await (await runtime.request(original.previewUrl)).arrayBuffer()), originalBytes);
    const inspection = new Database(path.join(directory, 'tasks.sqlite'), { readonly: true });
    const storageKey = inspection.prepare('SELECT storage_key FROM assets WHERE id=?').get(original.assetId).storage_key;
    inspection.close();
    const originalPath = path.join(directory, 'storage', 'assets', storageKey);
    fs.unlinkSync(originalPath);
    for (const state of ['missing', 'corrupt']) {
        if (state === 'corrupt')
            fs.writeFileSync(originalPath, Buffer.alloc(originalBytes.length));
        const rejected = await submit({ inputAssets: [{ assetId: original.assetId, role: 'reference', position: 0 }] });
        assert.equal(rejected.status, state === 'missing' ? 404 : 409, state + ' authoritative asset rejects');
        assert.equal(posts.length, ids.length, state + ' asset never reaches upstream');
        await forged();
    }
});

test('actual Web mode retains legacy expiry/ACK policy and does not create desktop schema tables', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-storage-web-'));
    const old = seed(directory);
    const runtime = await start(directory, { desktop: false });
    t.after(async () => { await runtime.stop(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    assert.equal((await (await runtime.request('/api/nova/tasks/' + old.completed)).json()).status, 'expired');
    const db = new Database(path.join(directory, 'tasks.sqlite'));
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    const id = randomUUID();
    db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(id, 'completed', 'text-to-image', '{}', new Date().toISOString());
    await runtime.request('/api/nova/tasks/' + id + '/ack', { method: 'POST' });
    const expires = Date.parse(db.prepare('SELECT expires_at FROM tasks WHERE id=?').get(id).expires_at);
    assert.ok(expires > Date.now() && expires < Date.now() + 125000);
    db.close();
});
