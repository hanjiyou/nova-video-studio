'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { migrateDatabase, MIGRATIONS } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
const { createTaskService, retryAfter } = require('../tasks/service');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 100; i++) { const result = fn(); if (result) return result; await tick(); } throw new Error('Task did not settle'); }
async function fixture(t, overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-t05-')), dbPath = path.join(directory, 'tasks.sqlite'), db = new Database(dbPath);
    await migrateDatabase({ db, dbPath });
    const store = createWorkbenchStore({ db, rootDirectory: path.join(directory, 'storage') }), connectionId = randomUUID(), versionId = randomUUID();
    db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(connectionId, 'synthetic', '2026-01-01', '2026-01-01');
    db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,created_at) VALUES(?,?,?,?,?)').run(versionId, connectionId, 'https://fixture.invalid/v1', 'openai-compatible', '2026-01-01');
    let time = Date.parse('2026-10-23T00:00:00Z'), credential = true, submits = 0, polls = 0, chosen;
    const snapshot = (extra = {}) => ({ contractVersion: 1, localRequestId: randomUUID(), connectionVersionId: versionId, mode: 'video.text', model: 'synthetic-model', prompt: '  中文\n"完整台词"\r\n第二行  ', parameters: { duration: 6 }, inputAssets: [], adapterId: 'synthetic', adapterVersion: '1', ...extra });
    const connections = { getAuth(id) { assert.equal(id, versionId); if (!credential) throw Object.assign(new Error('No credential'), { code: 'CREDENTIAL_REQUIRED' }); return { connectionVersionId: id, apiKey: 'synthetic-secret', baseUrl: 'https://fixture.invalid/v1' }; } };
    const implementation = { id: 'synthetic', version: '1', submit: async () => ({ upstreamTaskId: 'opaque-original-id' }), poll: async () => ({ remoteState: 'generating', rawStatus: 'rendering' }), ...overrides };
    const resolveAdapter = (..._args) => chosen === null ? null : ({ ...implementation, async submit(...a) { submits++; return implementation.submit(...a); }, async poll(...a) { polls++; return implementation.poll(...a); } });
    const make = options => createTaskService({ db, store, connections, resolveAdapter, now: () => time, random: () => 0.5, ...options });
    let service = make();
    t.after(async () => { await service.close(); if (db.open) db.close(); const actual = path.resolve(directory); assert.ok(actual.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    return { db, dbPath, directory, store, versionId, snapshot, enqueue: value => service.enqueue({ snapshot: value || snapshot(), mode: 'plugin', request: {} }),
        get service() { return service; }, get submits() { return submits; }, get polls() { return polls; }, implementation,
        advance(ms) { time += ms; }, credential(value) { credential = value; }, adapterMissing() { chosen = null; },
        async restart(options) { await service.close(); service = make(options); service.recover(); await tick(); return service; } };
}
test('enqueue commits snapshot and dispatch_started before exactly one POST; ID is committed before GET', async t => {
    let f; f = await fixture(t, { submit: async task => { const stored = f.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id); assert.equal(stored.status, 'submitting'); assert.ok(stored.dispatch_started_at); assert.ok(stored.input_snapshot_json); return { upstreamTaskId: 'id/with?opaque#bytes' }; }, poll: async task => { assert.equal(f.db.prepare('SELECT upstream_task_id FROM tasks WHERE id=?').get(task.id).upstream_task_id, task.upstream_task_id); return { remoteState: 'generating', rawStatus: 'RUNNING' }; } });
    const input = f.snapshot(), id = f.enqueue(input); await until(() => f.service.get(id).status === 'remote_queued');
    assert.equal(f.submits, 1); assert.equal(f.service.get(id).upstreamTaskId, 'id/with?opaque#bytes');
    f.advance(20000); await f.service.poll(id); assert.equal(f.polls, 1); assert.equal(f.service.get(id).status, 'generating');
    assert.equal(JSON.parse(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id).input_snapshot_json).prompt, input.prompt);
    assert.throws(() => f.db.prepare('UPDATE tasks SET upstream_task_id=? WHERE id=?').run('other', id), /IMMUTABLE_UPSTREAM/);
});
test('localRequestId is durable, case-insensitive, object-key independent; replay after revoked credential returns original and changed snapshot conflicts', async t => {
    const f = await fixture(t), input = f.snapshot(), id = f.enqueue(input); await until(() => f.service.get(id).status === 'remote_queued');
    f.credential(false); assert.equal(f.enqueue({ ...input, parameters: { duration: 6 }, localRequestId: input.localRequestId.toUpperCase() }), id);
    assert.throws(() => f.enqueue({ ...input, prompt: 'changed' }), { code: 'LOCAL_REQUEST_CONFLICT' });
    await f.restart(); assert.equal(f.enqueue(input), id); assert.equal(f.submits, 1);
});
test('queued cancellation races preflight safely and never dispatches cancelled intent', async t => {
    const f = await fixture(t), id = f.enqueue(); f.service.action(id, 'cancel-queued'); await tick(); assert.equal(f.submits, 0); assert.equal(f.service.get(id).status, 'local_cancelled');
});
test('restart of never-dispatched queue requires explicit continue; cancel is available before dispatch', async t => {
    const f = await fixture(t), first = f.enqueue(); await until(() => f.service.get(first).status === 'remote_queued');
    const second = f.enqueue(); await f.restart(); assert.equal(f.service.get(second).status, 'local_queued'); assert.equal(f.service.get(second).requiresContinue, true);
    f.implementation.poll = async () => ({ remoteState: 'failed', rawStatus: 'failed' }); f.advance(20000); await f.service.poll(first); await tick(); assert.equal(f.submits, 1);
    f.service.action(second, 'continue-queued'); await until(() => f.submits === 2); assert.equal(f.service.get(second).requiresContinue, false);
});
for (const cause of ['network', '503', 'empty-id']) test('uncertain submit ' + cause + ' never retries POST and keeps single generation reservation across restart', async t => {
    const f = await fixture(t, { submit: async () => { if (cause === 'empty-id') return { upstreamTaskId: '' }; throw Object.assign(new Error('synthetic upstream detail'), { httpStatus: cause === '503' ? 503 : undefined }); } });
    const id = f.enqueue(); await until(() => f.service.get(id).status === 'submission_unknown'); const next = f.enqueue(); await tick();
    assert.equal(f.submits, 1); assert.equal(f.service.get(next).status, 'local_queued'); assert.equal(f.service.get(id).generationReserved, true); assert.equal(f.service.get(id).remoteMayContinue, true); assert.match(f.service.get(id).schedulingNotice, /计费/);
    await f.restart(); f.service.action(next, 'continue-queued'); await tick(); assert.equal(f.submits, 1); assert.equal(f.polls, 0);
});
test('complete explicit POST rejection permits queue progress; POST 429 never follows Retry-After', async t => {
    const f = await fixture(t, { submit: async () => { throw Object.assign(new Error('synthetic rejection'), { httpStatus: 429, transmission: 'response_received', definiteRejection: true, retryAfter: '1' }); } });
    const id = f.enqueue(); await until(() => f.service.get(id).status === 'failed'); f.advance(200000); await tick(); assert.equal(f.submits, 1); assert.equal(f.service.get(id).taskError.code, 'REMOTE_REJECTED'); assert.equal(f.service.get(id).taskError.transmission, 'response_received');
});
test('restart after dispatch and before ID becomes submission_unknown; an existing ID resumes GET only', async t => {
    const f = await fixture(t), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_queued');
    const unknown = f.enqueue(); f.db.prepare("UPDATE tasks SET status='submitting',dispatch_started_at=? WHERE id=?").run('2026-10-22T00:00:00Z', unknown);
    await f.restart(); assert.equal(f.service.get(unknown).status, 'submission_unknown'); f.advance(20000); await f.service.poll(id); assert.equal(f.submits, 1); assert.equal(f.polls, 1);
});
test('stop polling retains reservation, ignores late GET, survives restart, and resume uses original ID only', async t => {
    let finish;
    const f = await fixture(t, { poll: async () => new Promise(resolve => { finish = resolve; }) }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_queued');
    f.advance(20000); const pending = f.service.poll(id); await until(() => finish); f.service.action(id, 'stop-polling');
    const next = f.enqueue(); finish({ remoteState: 'completed', rawStatus: 'completed', resultSources: [{ kind: 'url', url: 'https://cdn.invalid/result.mp4' }] }); await pending;
    assert.equal(f.service.get(id).status, 'polling_paused'); assert.equal(f.service.get(next).status, 'local_queued'); assert.equal(f.submits, 1);
    await f.restart(); assert.equal(f.service.get(id).pauseReason, 'user_stopped'); assert.equal(f.polls, 1);
    f.implementation.poll = async task => { assert.equal(task.upstream_task_id, 'opaque-original-id'); return { remoteState: 'failed', rawStatus: 'failed' }; };
    f.service.action(id, 'resume-polling'); await f.service.poll(id); assert.equal(f.submits, 1); assert.equal(f.service.get(id).status, 'failed');
});
test('attach upstream ID requires an unknown task, validates opaque ID, persists it, and does no POST or GET until explicit resume', async t => {
    const f = await fixture(t, { submit: async () => { throw new Error('lost ACK'); } }), id = f.enqueue(); await until(() => f.service.get(id).status === 'submission_unknown');
    for (const upstreamTaskId of ['', 'line\nbreak', 'synthetic-secret', '%73%79%6e%74%68%65%74%69%63%2d%73%65%63%72%65%74']) assert.throws(() => f.service.action(id, 'attach-upstream-id', { upstreamTaskId }), { code: 'INVALID_UPSTREAM_ID' });
    f.service.action(id, 'attach-upstream-id', { upstreamTaskId: 'user-known-id/opaque' }); assert.equal(f.submits, 1); assert.equal(f.polls, 0);
    f.service.action(id, 'resume-polling'); await f.service.poll(id); assert.equal(f.polls, 1); assert.equal(f.submits, 1); assert.equal(f.service.get(id).upstreamTaskId, 'user-known-id/opaque');
});
for (const status of [401, 403]) test('GET ' + status + ' pauses without treating remote as failed or releasing the reservation', async t => {
    const f = await fixture(t, { poll: async () => { throw Object.assign(new Error('auth'), { httpStatus: status }); } }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_queued'); f.advance(20000); await f.service.poll(id);
    assert.equal(f.service.get(id).status, 'polling_paused'); assert.equal(f.service.get(id).taskError.code, 'AUTH_REJECTED'); assert.equal(f.service.get(id).generationReserved, true); f.enqueue(); await tick(); assert.equal(f.submits, 1);
});
test('cleared original credential pauses before GET, retains ID/snapshot, and cannot silently select a new version', async t => {
    const f = await fixture(t), input = f.snapshot(), id = f.enqueue(input); await until(() => f.service.get(id).status === 'remote_queued'); f.credential(false); f.advance(20000); await f.service.poll(id);
    assert.equal(f.polls, 0); assert.equal(f.service.get(id).status, 'polling_paused'); assert.equal(f.service.get(id).upstreamTaskId, 'opaque-original-id'); assert.equal(f.service.get(id).connectionVersionId, f.versionId); assert.throws(() => f.service.action(id, 'resume-polling'), { code: 'CREDENTIAL_REQUIRED' });
});
test('unrecognized remote state preserves safe raw status and pauses; no false failure/completion', async t => {
    const f = await fixture(t, { poll: async () => ({ remoteState: 'unknown', rawStatus: 'Supplier_New_Status' }) }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_queued'); f.advance(20000); await f.service.poll(id);
    const task = f.service.get(id); assert.equal(task.status, 'polling_paused'); assert.equal(task.rawStatus, 'Supplier_New_Status'); assert.equal(task.remoteState, 'unknown');
});
test('GET transient retry count is bounded and persists across restarts; no POST retry', async t => {
    const f = await fixture(t, { poll: async () => { throw new Error('offline synthetic-secret'); } }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_queued');
    for (let index = 0; index < 6; index++) { f.advance(120000); await f.service.poll(id); if (index === 1) await f.restart(); }
    assert.equal(f.service.get(id).status, 'polling_paused'); assert.equal(f.service.get(id).taskError.code, 'POLL_TRANSIENT'); assert.equal(f.polls, 5); assert.equal(f.submits, 1);
    assert.equal(JSON.stringify(f.store.events(id)).includes('synthetic-secret'), false);
});
test('GET Retry-After beyond cap is never truncated, persists notBeforeAt, and rejects early resume', async t => {
    const f = await fixture(t, { poll: async () => { throw Object.assign(new Error('429'), { httpStatus: 429, retryAfter: '180' }); } }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_queued'); f.advance(20000); await f.service.poll(id);
    const notBefore = f.service.get(id).notBeforeAt; assert.equal(f.service.get(id).status, 'polling_paused'); assert.throws(() => f.service.action(id, 'resume-polling'), { code: 'POLL_NOT_BEFORE', notBeforeAt: notBefore });
    await f.restart(); f.advance(120000); assert.throws(() => f.service.action(id, 'resume-polling'), { code: 'POLL_NOT_BEFORE' }); assert.equal(f.polls, 1);
    f.advance(60000); f.service.action(id, 'resume-polling'); await f.service.poll(id); assert.equal(f.polls, 2); assert.equal(f.submits, 1);
});
test('short Retry-After controls next GET and successful status clears failure budget', async t => {
    const f = await fixture(t, { poll: async () => { throw Object.assign(new Error('429'), { httpStatus: 429, retryAfter: '30' }); } }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_queued'); f.advance(20000); await f.service.poll(id); f.advance(29999); await f.service.poll(id); assert.equal(f.polls, 1);
    f.implementation.poll = async () => ({ remoteState: 'queued', rawStatus: 'queued' }); f.advance(1); await f.service.poll(id); assert.equal(f.polls, 2); assert.equal(f.db.prepare('SELECT poll_attempts FROM tasks WHERE id=?').get(id).poll_attempts, 0);
});
test('Retry-After numeric/date parsing and invalid values', () => {
    const time = Date.parse('2026-10-23T00:00:00Z'); assert.equal(retryAfter('40', time), 40000); assert.equal(retryAfter('Fri, 23 Oct 2026 00:01:00 GMT', time), 60000); assert.equal(retryAfter('garbage', time), null); assert.equal(retryAfter('-1', time), null); assert.equal(retryAfter(null, time), null);
});
test('remote completion queues downloads independently, releases generation and never claims local completed without a verifier', async t => {
    const f = await fixture(t, { submit: async () => ({ resultSources: [{ kind: 'url', url: 'https://cdn.invalid/result.png', authScope: 'none' }] }) }); const first = f.enqueue(), second = f.enqueue();
    await until(() => f.service.get(second).status === 'remote_completed'); assert.equal(f.submits, 2); assert.equal(f.service.get(first).status, 'remote_completed'); assert.equal(f.service.stats().downloadQueued, 2); assert.equal(f.service.stats().processingCount, 0);
    await f.restart(); assert.equal(f.service.get(first).status, 'remote_completed'); assert.equal(f.submits, 2); assert.equal(f.service.get(first).outputAssets.length, 0);
});
test('inline output is a managed unverified candidate, never an exposed base64 result or local completion', async t => {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1/reference-a.png'));
    const f = await fixture(t, { submit: async () => ({ resultSources: [{ kind: 'inline', bytes, mimeType: 'image/png' }] }) }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_completed');
    const stored = JSON.parse(f.db.prepare('SELECT result_sources_json FROM tasks WHERE id=?').get(id).result_sources_json); assert.equal(stored[0].kind, 'asset'); assert.equal(f.store.getAsset(stored[0].assetId).validationState, 'unverified'); assert.equal(JSON.stringify(f.service.get(id)).includes(bytes.toString('base64')), false);
});
test('query-bearing or credential-bearing candidate URL is not saved/exported; failure cannot generate again', async t => {
    const f = await fixture(t, { submit: async () => ({ resultSources: [{ kind: 'url', url: 'https://cdn.invalid/result?token=synthetic-secret' }] }) }), id = f.enqueue(); await until(() => f.service.get(id).status === 'download_failed');
    assert.equal(f.db.prepare('SELECT result_sources_json FROM tasks WHERE id=?').get(id).result_sources_json, null); assert.equal(JSON.stringify(f.service.get(id)).includes('synthetic-secret'), false); assert.throws(() => f.service.action(id, 'retry-download'), { code: 'RESULT_REFRESH_REQUIRED' }); assert.equal(f.submits, 1);
});
test('download interruption recovers only the download queue, with no submit or poll', async t => {
    const f = await fixture(t, { submit: async () => ({ resultSources: [{ kind: 'url', url: 'https://cdn.invalid/result.mp4' }] }) }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_completed'); f.db.prepare("UPDATE tasks SET status='downloading' WHERE id=?").run(id); f.db.prepare("UPDATE task_downloads SET state='running' WHERE task_id=?").run(id);
    await f.restart(); assert.equal(f.service.get(id).status, 'remote_completed'); assert.equal(f.service.stats().downloadQueued, 1); assert.equal(f.submits, 1); assert.equal(f.polls, 0);
});
test('download worker failure remains retryable and never uses the generation slot or marks unverified bytes completed', async t => {
    const f = await fixture(t, { submit: async () => ({ resultSources: [{ kind: 'url', url: 'https://cdn.invalid/result.png' }] }) }), id = f.enqueue(); await until(() => f.service.get(id).status === 'remote_completed');
    await f.restart({ downloadWorker: async () => { throw new Error('disk full'); } }); await until(() => f.service.get(id).status === 'download_failed'); assert.equal(f.submits, 1); f.service.action(id, 'retry-download'); await until(() => f.service.get(id).status === 'download_failed'); assert.equal(f.submits, 1);
});
test('schema v3 to v4 keeps historical SQL checksums, committed WAL rows and a consistent rollback backup', async t => {
    const f = await fixture(t), dbPath=path.join(f.directory,'v3.sqlite'), db=new Database(dbPath);
    try {
        await migrateDatabase({db,dbPath,migrations:MIGRATIONS.slice(0,3)}); db.pragma('journal_mode=WAL');
        const id=randomUUID(); db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(id,'processing','plugin','{}','2026-10-23');
        const history=db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
        const upgraded=await migrateDatabase({db,dbPath}); assert.deepEqual(upgraded.applied,[4]);
        assert.deepEqual(db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=3 ORDER BY version').all(),history);
        const backup=new Database(upgraded.backupFile,{readonly:true});try {assert.equal(backup.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'processing');assert.equal(backup.pragma('quick_check',{simple:true}),'ok');}finally {backup.close();}
        assert.deepEqual(db.pragma('foreign_key_check'),[]);
    } finally {db.close();}
});
test('GET failure count limit pauses after five automatic retries even with a larger elapsed-time budget',async t=>{
    const f=await fixture(t,{poll:async()=>{throw new Error('offline');}});await f.restart({policy:{budgetMs:100000000}});
    const id=f.enqueue();await until(()=>f.service.get(id).status==='remote_queued');
    for(let n=0;n<6;n++){f.advance(120000);await f.service.poll(id);}
    assert.equal(f.polls,6);assert.equal(f.service.get(id).status,'polling_paused');assert.equal(f.submits,1);
});
test('dispatch persistence failure stops scheduling before any adapter POST and keeps the durable queued snapshot',async t=>{
    const f=await fixture(t), id=f.enqueue();
    f.db.exec("CREATE TRIGGER synthetic_disk_failure BEFORE UPDATE OF dispatch_started_at ON tasks WHEN NEW.dispatch_started_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'SYNTHETIC_STORAGE_FAILURE');END;");
    await until(()=>f.service.stats().schedulerError);assert.equal(f.service.stats().acceptingNewTasks,false);assert.equal(f.submits,0);assert.equal(f.service.get(id).status,'local_queued');assert.ok(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id).input_snapshot_json);
});
test('an ID callback is persisted before later adapter parsing fails; only GET recovery remains available',async t=>{
    let f; f=await fixture(t,{submit:async(_task,_snapshot,auth)=>{auth.onAccepted('already-accepted-ID');assert.equal(f.db.prepare('SELECT upstream_task_id FROM tasks WHERE upstream_task_id=?').get('already-accepted-ID').upstream_task_id,'already-accepted-ID');throw new Error('later parser failure');}});
    const id=f.enqueue();await until(()=>f.service.get(id).status==='polling_paused');assert.equal(f.service.get(id).upstreamTaskId,'already-accepted-ID');
    f.service.action(id,'resume-polling');await f.service.poll(id);assert.equal(f.submits,1);assert.equal(f.polls,1);
});

test('complete POST authentication rejection is classified for reauthentication, never as a remote generation failure',async t=>{
    const f=await fixture(t,{submit:async()=>{throw Object.assign(new Error('synthetic auth rejection'),{httpStatus:401,transmission:'response_received',definiteRejection:true});}}), id=f.enqueue();
    await until(()=>f.service.get(id).status==='failed');const task=f.service.get(id);assert.equal(task.taskError.code,'AUTH_REJECTED');assert.equal(task.taskError.phase,'credential');assert.equal(task.taskError.retryAction,'reauthenticate');assert.equal(task.taskError.transmission,'response_received');assert.equal(f.submits,1);
});
