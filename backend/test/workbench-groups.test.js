'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto'), Database = require('better-sqlite3');
const { migrateDatabase, MIGRATIONS } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
const { DEFAULT_GROUP, LIMITS } = require('../storage/groups');
const { validateMedia } = require('../storage/media-validator');
const { createDownloadWorker } = require('../storage/download-worker');
const { createTaskService } = require('../tasks/service');
const { createAssetActions } = require('../../desktop/asset-actions.cjs');
const { start } = require('./support/desktop-http-runtime.cjs');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1/reference-a.png'));
const video = fs.readFileSync(path.join(__dirname, 'fixtures/b2/valid-video.mp4'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refs = assets => assets.map((asset, position) => ({ assetId: asset.assetId, position, role: 'reference' }));
function cleanup(directory) { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); }
async function fixture(t, old = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-g01-')), dbPath = path.join(directory, 'tasks.sqlite'), db = new Database(dbPath);
    t.after(() => { if (db.open) db.close(); cleanup(directory); });
    await migrateDatabase({ db, dbPath, ...(old ? { migrations: MIGRATIONS.slice(0, 11) } : {}) });
    const root = path.join(directory, '中文 根目录 (测试)&');
    return { directory, dbPath, db, root, get store() { return createWorkbenchStore({ db, rootDirectory: root }); } };
}
function task(f, mode = 'image.text', groupId) {
    const store = f.store, snapshot = store.freezeOutputDirectory({ contractVersion: 1, localRequestId: randomUUID(), mode, model: 'synthetic', prompt: '海边嬉水 / 中文 (甲)&乙', parameters: {}, inputAssets: [], ...(groupId ? { groupId } : {}) });
    const id = randomUUID();
    f.db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,execution_media_kind) VALUES(?,?,?,?,?,?)').run(id, 'completed', mode, '{}', '2026-10-27T06:32:00.000Z', mode.startsWith('image.') ? 'image' : 'video');
    store.setTaskSnapshot(id, snapshot);
    return f.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}
async function publish(f, row, position = 0, bytes = png) {
    const file = path.join(f.directory, '合成 素材(原件)&.part'); fs.writeFileSync(file, bytes);
    const metadata = await validateMedia(file, { expectedKind: row.execution_media_kind });
    return f.store.publishVerifiedFile(file, metadata, row.output_root_ref, { task: row, position });
}
test('G01 v11 upgrade preserves all asset references/checksums/legacy paths and creates stable default membership', async t => {
    const f = await fixture(t, true), id = randomUUID(), assetId = randomUUID(), digest = sha(png), key = path.join(digest.slice(0, 2), digest + '.png');
    const directory = path.join(f.root, 'assets', digest.slice(0, 2)); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(f.root, 'assets', key), png);
    f.db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,input_snapshot_json) VALUES(?,?,?,?,?,?)').run(id, 'completed', 'image.text', '{}', '2026-10-27', JSON.stringify({ prompt: '旧中文', mode: 'image.text' }));
    f.db.prepare('INSERT INTO assets(id,kind,storage_key,display_name,mime_type,byte_length,sha256,source_kind,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(assetId, 'image', key, '旧图', 'image/png', png.length, digest, 'generated', '2026-10-27');
    f.db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?)').run('image.text', '旧草稿', 'old', '{}', 8, '2026-10-27');
    f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(id, assetId, 'output', 0);
    f.db.prepare('INSERT INTO draft_assets VALUES(?,?,?)').run('image.text', assetId, 0);
    f.db.prepare('INSERT INTO asset_legacy_links VALUES(?,?,?)').run('image', 'old.png', assetId);
    f.db.prepare('INSERT INTO task_download_files VALUES(?,?,?,?,?,?)').run(id, 'old-source', assetId, digest, png.length, 0);
    const oldHistory = f.db.prepare('SELECT version,checksum FROM schema_migrations').all(), before = f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id);
    const upgraded = await migrateDatabase({ db: f.db, dbPath: f.dbPath }); assert.deepEqual(upgraded.applied, MIGRATIONS.slice(11).map(item=>item.version));
    assert.deepEqual(f.db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<12').all(), oldHistory);
    for (const table of ['task_assets','draft_assets','asset_legacy_links','task_download_files']) assert.equal(f.db.prepare('SELECT asset_id FROM ' + table).get().asset_id, assetId);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('quick_check', { simple: true }), 'ok');
    const store = f.store; assert.deepEqual(store.readAsset(assetId).bytes, png); assert.equal(store.getDraft('image.text').groupId, DEFAULT_GROUP); assert.equal(store.getDraft('image.text').revision, 8);
    assert.equal(store.getTask(id).groupId, DEFAULT_GROUP); assert.deepEqual(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id), before);
    assert.equal(fs.existsSync(path.join(f.root, 'assets', '未分组')), false); assert.ok(fs.existsSync(path.join(f.root, 'assets', key)));
    const revision = store.getTask(id).revision; f.db.prepare("UPDATE assets SET availability='missing' WHERE id=?").run(assetId); assert.ok(store.getTask(id).revision > revision);
    assert.throws(() => f.db.prepare('DELETE FROM assets WHERE id=?').run(assetId), /FOREIGN KEY/);
    assert.throws(() => f.db.prepare("UPDATE tasks SET input_snapshot_json='{}' WHERE id=?").run(id), /IMMUTABLE_TASK_SNAPSHOT/);
});
test('G01 groups persist, create Unicode media directories and reject reserved/invalid/case-equivalent names', async t => {
    const f = await fixture(t), store = f.store;
    assert.equal(store.groups().defaultGroupId, DEFAULT_GROUP); assert.equal(store.groups().items[0].name, '未分组');
    const group = store.createGroup({ name: '海边 Short (A)& B' });
    assert.equal(f.store.groups().items[1].groupId, group.groupId);
    for (const child of ['图片','视频']) assert.ok(fs.statSync(path.join(group.outputLocation, child)).isDirectory());
    for (const name of ['','../x','a/b','a\\b','D:\\x','con','CON.txt','aux.abc','LPT¹.png','尾点.','尾空格 ','x\u0000','x\ud800','x'.repeat(49)]) assert.throws(() => store.createGroup({ name }), { code: 'GROUP_NAME_INVALID' });
    assert.throws(() => store.createGroup({ name: '海边 short (a)& b' }), { code: 'GROUP_NAME_CONFLICT' });
    assert.throws(() => store.createGroup({ name: '未分组' }), { code: 'GROUP_NAME_CONFLICT' });
    assert.throws(() => f.db.prepare("UPDATE workbench_groups SET name='改名' WHERE id=?").run(DEFAULT_GROUP), /IMMUTABLE_DEFAULT_GROUP/);
    assert.throws(() => store.createGroup({ name: 'x', directory: 'outside' }), { code: 'INVALID_STORAGE_INPUT' });
});
test('G01 unregistered same-name files/directories are preserved and root aliases recognize their own groups', async t => {
    const f = await fixture(t), store = f.store; fs.mkdirSync(path.join(f.root, 'assets', '用户目录')); fs.writeFileSync(path.join(f.root, 'assets', '用户目录', '保留.txt'), 'keep');
    assert.throws(() => store.createGroup({ name: '用户目录' }), { code: 'GROUP_DIRECTORY_CONFLICT' });
    fs.writeFileSync(path.join(f.root, 'assets', '已有文件'), 'keep'); assert.throws(() => store.createGroup({ name: '已有文件' }), { code: 'GROUP_DIRECTORY_CONFLICT' });
    const group = store.createGroup({ name: '共享根' }), first = store.freezeOutputDirectory({ mode: 'image.text', groupId: group.groupId });
    store.selectOutputDirectory(f.root); const second = store.freezeOutputDirectory({ mode: 'video.text', groupId: group.groupId });
    assert.notEqual(first.outputRootRef, second.outputRootRef); assert.notEqual(first.groupDirectoryVersionId, second.groupDirectoryVersionId);
    store.freezeOutputDirectory({ mode: 'image.text' }); store.selectOutputDirectory(f.root); store.freezeOutputDirectory({ mode: 'image.text' });
    assert.equal(fs.readFileSync(path.join(f.root, 'assets', '用户目录', '保留.txt'), 'utf8'), 'keep');
});
test('G01 group+mode drafts isolate revisions and grouped references protect output deletion', async t => {
    const f = await fixture(t), store = f.store, a = store.createGroup({ name: '甲组' }), b = store.createGroup({ name: '乙组' }), row = task(f), asset = await publish(f, row);
    store.bindTaskAssets(row.id, refs([asset]), 'output');
    const body = { prompt: '甲\n中文', model: 'synthetic', parameters: {}, inputAssets: refs([asset]), expectedRevision: 0 };
    store.putDraft('image.text', body, a.groupId); store.putDraft('image.text', { ...body, prompt: '默认' });
    assert.equal(store.getDraft('image.text', b.groupId).revision, 0); assert.equal(store.getDraft('video.text', a.groupId).revision, 0);
    assert.throws(() => store.putDraft('image.text', body, a.groupId), { code: 'DRAFT_REVISION_CONFLICT' });
    assert.equal(f.store.getDraft('image.text', a.groupId).prompt, '甲\n中文'); assert.equal(store.countReferences(asset.assetId), 3);
    store.putDraft('image.text', { ...body, inputAssets: [], expectedRevision: 1 });
    assert.equal(store.removeHistory(row.id, { deleteOutputs: true }).retainedAssets, 1); assert.deepEqual(store.readAsset(asset.assetId).bytes, png);
});
test('G01 new default and selected group outputs use stable readable names, distinct equal bytes and local creation time', async t => {
    const f = await fixture(t), a = task(f), group = f.store.createGroup({ name: '海边短片' }), b = task(f, 'image.text', group.groupId);
    const first = await publish(f, a), second = await publish(f, b), multi = await publish(f, b, 1);
    const firstPath = f.store.resolveAssetPath(first.assetId), secondPath = f.store.resolveAssetPath(second.assetId);
    assert.ok(firstPath.includes(path.join('assets','未分组','图片'))); assert.ok(secondPath.includes(path.join('assets','海边短片','图片')));
    assert.match(path.basename(secondPath), /^\d{8}-\d{6}_海边嬉水 中文 \(甲\)&乙_[a-f0-9]{12}\.png$/);
    const when = new Date(b.created_at), pad = n => String(n).padStart(2,'0'); assert.ok(path.basename(secondPath).startsWith('20261027-' + pad(when.getHours()) + '3200_'));
    assert.notEqual(first.assetId, second.assetId); assert.notEqual(multi.assetId, second.assetId);
    const again = await publish(f, b); assert.equal(again.assetId, second.assetId); assert.equal(f.store.resolveAssetPath(again.assetId), secondPath);
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_output_locations WHERE task_id=?').get(b.id).n, 2);
    const frozen = JSON.parse(b.input_snapshot_json); assert.equal(frozen.groupName, '海边短片'); assert.equal(f.store.getTask(b.id).submittedGroupName, '海边短片');
    assert.throws(() => f.store.setTaskSnapshot(b.id, { ...frozen, groupId: DEFAULT_GROUP }), { code: 'IMMUTABLE_TASK_SNAPSHOT' });
});
test('G01 root changes keep old task snapshot/location and create new logical group location at current root', async t => {
    const f = await fixture(t), group = f.store.createGroup({ name: '连续剧' }), first = task(f, 'image.text', group.groupId);
    const next = path.join(f.directory, '新的 根 (二)&'); fs.mkdirSync(next); f.store.selectOutputDirectory(next);
    const second = task(f, 'image.text', group.groupId), asset1 = await publish(f, first), asset2 = await publish(f, second);
    assert.ok(f.store.resolveAssetPath(asset1.assetId).startsWith(fs.realpathSync.native(f.root) + path.sep)); assert.ok(f.store.resolveAssetPath(asset2.assetId).startsWith(fs.realpathSync.native(next) + path.sep));
    assert.equal(f.store.getTask(first.id).groupId, group.groupId); assert.equal(f.store.getTask(second.id).groupId, group.groupId);
    assert.ok(f.store.getTask(first.id).outputLocation.startsWith(fs.realpathSync.native(f.root))); assert.ok(f.store.getTask(second.id).outputLocation.startsWith(fs.realpathSync.native(next)));
});
test('G01 collision allocation never overwrites user file; ownership survives publication-checkpoint interruption', async t => {
    const f = await fixture(t), row = task(f), suffix = sha(Buffer.from(row.id + ':0')).slice(0,12), directory = path.join(f.root, 'assets','未分组','图片');
    // Reserve the deterministic first candidate by calculating the exact same task timestamp.
    const when = new Date(row.created_at), pad = n => String(n).padStart(2,'0'), stamp = '20261027-' + pad(when.getHours()) + '3200';
    const occupied = path.join(directory, stamp + '_海边嬉水 中文 (甲)&乙_' + suffix + '.png'); fs.writeFileSync(occupied, 'user-owned');
    f.db.exec("CREATE TRIGGER g01_interrupt BEFORE UPDATE OF availability ON assets WHEN NEW.group_id IS NOT NULL AND NEW.availability='available' BEGIN SELECT RAISE(ABORT,'SIMULATED_CRASH'); END;");
    await assert.rejects(publish(f, row), { code: 'STORAGE_OPERATION_FAILED' });
    const pending = f.db.prepare('SELECT * FROM assets WHERE group_id IS NOT NULL').get(); assert.equal(pending.validation_state, 'unverified'); assert.equal(pending.availability, 'missing');
    assert.match(pending.storage_key, /_1\.png$/); assert.equal(fs.readFileSync(occupied, 'utf8'), 'user-owned');
    f.db.exec('DROP TRIGGER g01_interrupt'); const recovered = await publish(f, row);
    assert.equal(recovered.assetId, pending.id); assert.equal(recovered.validationState, 'verified'); assert.deepEqual(f.store.readAsset(recovered.assetId).bytes, png);
});
test('G01 unsafe directory junctions are rejected before generation and reading, outside files stay intact', async t => {
    const f = await fixture(t), group = f.store.createGroup({ name: '链接边界' }), row = task(f, 'image.text', group.groupId), asset = await publish(f, row), outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'outside');
    const directory = path.join(group.outputLocation,'图片');
    fs.renameSync(directory, directory + '-original'); fs.symlinkSync(outside, directory, 'junction');
    assert.throws(() => f.store.freezeOutputDirectory({ mode: 'image.text', groupId: group.groupId }), { code: 'ASSET_PATH_REJECTED' });
    assert.throws(() => f.store.readAsset(asset.assetId), { code: 'ASSET_PATH_REJECTED' });
    assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'), 'outside');
    fs.unlinkSync(directory); fs.renameSync(directory + '-original', directory);
});
test('G01 complete and temporary path budgets reject before any upstream POST', async t => {
    const f = await fixture(t), store = f.store;
    const longRoot = path.join(f.directory, '长'.repeat(100)); fs.mkdirSync(longRoot); store.selectOutputDirectory(longRoot);
    assert.throws(() => store.freezeOutputDirectory({ mode: 'video.text' }), { code: 'PATH_TOO_LONG' });
    assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 0); assert.equal(LIMITS.fullPath, 240);
    store.selectOutputDirectory(f.root); const outside = path.join(f.directory,'temp-outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.root,'.nova-parts'), 'junction');
    assert.throws(() => store.freezeOutputDirectory({ mode: 'image.text' }), { code: 'ASSET_PATH_REJECTED' });
    fs.unlinkSync(path.join(f.root,'.nova-parts'));
});
test('G01 real video decode, worker save, asset read, native save-copy/reveal and restart work with Chinese spaces parentheses ampersands', async t => {
    const f = await fixture(t), store = f.store, group = store.createGroup({ name: '海边 (夜) & Short' }), row = task(f, 'video.text', group.groupId);
    const worker = createDownloadWorker({ store, connections: { getAuth: () => ({ baseUrl:'https://fixture.invalid/v1', apiKey:'synthetic-only' }) }, checkUrl: async () => {}, fetchImpl: async () => new Response(video) });
    const result = await worker(row, [{ kind:'url',url:'https://fixture.invalid/media.mp4',mediaKind:'video' }]);
    const assetId = result.assetIds[0], file = store.resolveAssetPath(assetId); assert.ok(file.includes(path.join('assets','海边 (夜) & Short','视频'))); assert.deepEqual(store.readAsset(assetId).bytes, video);
    assert.equal((await validateMedia(file,{ expectedKind:'video' })).decodedFrames, 24);
    const target = path.join(f.directory,'另存 中文 (副本)&.mp4'), revealed = [];
    const actions = createAssetActions({ getStore: () => store, dialog: { showSaveDialog: async () => ({ canceled:false,filePath:target }) }, shell: { showItemInFolder: value => revealed.push(value) }, getWindow: () => null });
    const copied = await actions.save(assetId); assert.equal(copied.ok, true); assert.deepEqual(fs.readFileSync(target), video); await actions.reveal(assetId); assert.deepEqual(revealed,[file]);
    assert.deepEqual(f.store.readAsset(assetId).bytes, video); assert.equal(fs.readdirSync(store.downloadDirectory(row.output_root_ref)).length,0);
});
test('G01 storage HTTP groups and grouped/default draft aliases persist across a real backend restart', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'nova-g01-http-')); let runtime = await start(directory);
    t.after(async () => { await runtime.stop(); cleanup(directory); });
    const send = (url,method,body) => runtime.request(url,{ method,headers:{'content-type':'application/json'},body:JSON.stringify(body) });
    const groups = await (await runtime.request('/api/nova/storage/groups')).json(); assert.equal(groups.defaultGroupId, DEFAULT_GROUP);
    const response = await send('/api/nova/storage/groups','POST',{name:'HTTP 中文 (甲)&'}); assert.equal(response.status,201); const group = (await response.json()).group;
    const body = {prompt:'保留\n独立输入',model:'fixture',parameters:{},inputAssets:[],expectedRevision:0};
    assert.equal((await send('/api/nova/storage/groups/'+group.groupId+'/drafts/image.text','PUT',body)).status,200);
    assert.equal((await send('/api/nova/storage/drafts/image.text','PUT',{...body,prompt:'默认'})).status,200);
    assert.equal((await send('/api/nova/storage/groups/'+group.groupId+'/drafts/image.text','PUT',body)).status,409);
    await runtime.stop(); runtime = await start(directory);
    assert.equal((await(await runtime.request('/api/nova/storage/groups/'+group.groupId+'/drafts/image.text')).json()).draft.prompt,body.prompt);
    assert.equal((await(await runtime.request('/api/nova/storage/groups/'+DEFAULT_GROUP+'/drafts/image.text')).json()).draft.prompt,'默认');
    assert.equal((await send('/api/nova/storage/groups','POST',{name:'../bad'})).status,400);
    assert.equal((await runtime.request('/api/nova/storage/groups/not-id/drafts/image.text')).status,404);
});
test('G01 dispatch rechecks a queued task directory after adapter preflight and never submits when root becomes unsafe', async t => {
    const f = await fixture(t), store = f.store, group = store.createGroup({ name:'派发前检查' }), connectionId = randomUUID(), versionId = randomUUID(), outside = path.join(f.directory,'外部'); fs.mkdirSync(outside);
    f.db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(connectionId,'synthetic','2026','2026');
    f.db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,created_at) VALUES(?,?,?,?,?)').run(versionId,connectionId,'https://fixture.invalid/v1','synthetic','2026');
    let posts = 0; const directory = path.join(group.outputLocation,'图片');
    const service = createTaskService({ db:f.db,store,connections:{getAuth:()=>({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic'})},resolveAdapter:()=>({id:'test',version:'1',preflight:async()=>{fs.rmdirSync(directory);fs.symlinkSync(outside,directory,'junction');},submit:async()=>{posts++;return {};}}) });
    t.after(()=>service.close()); const id = service.enqueue({snapshot:{contractVersion:1,localRequestId:randomUUID(),connectionVersionId:versionId,mode:'image.text',model:'synthetic',prompt:'test',parameters:{},inputAssets:[],adapterId:'test',adapterVersion:'1',groupId:group.groupId},request:{},mode:'image.text'});
    const end = Date.now()+2000; while(service.get(id).status==='local_queued'&&Date.now()<end) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(service.get(id).status,'failed'); assert.equal(service.get(id).taskError.code,'ASSET_PATH_REJECTED'); assert.equal(service.get(id).taskError.transmission,'not_dispatched'); assert.equal(posts,0);
    fs.unlinkSync(directory);
});
