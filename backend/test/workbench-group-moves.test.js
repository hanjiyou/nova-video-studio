'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto'), Database = require('better-sqlite3');
const { migrateDatabase } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
const { createGroups, DEFAULT_GROUP } = require('../storage/groups');
const { createOutputDirectories } = require('../storage/output-directories');
const { createGroupMoves } = require('../storage/group-moves');
const { validateMedia } = require('../storage/media-validator');
const { createDownloadWorker } = require('../storage/download-worker');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1/reference-a.png'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-g03-')), dbPath = path.join(directory, 'tasks.sqlite'), db = new Database(dbPath), root = path.join(directory, '中文 根 (一)&');
    t.after(() => { if (db.open) db.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });
    await migrateDatabase({ db, dbPath });
    const store = createWorkbenchStore({ db, rootDirectory: root }), outputDirectories = createOutputDirectories({ db, defaultDirectory: root }), groups = createGroups({ db, outputDirectories });
    const f = { directory, root, db, dbPath, store, outputDirectories, groups };
    f.moves = overrides => createGroupMoves({ db, groups, outputDirectories, trustedPath: asset => { try { return store.resolveAssetPath(asset.id); } catch (cause) { if (['ASSET_MISSING','ASSET_NOT_FOUND'].includes(cause.code)) return null; throw cause; } }, ...overrides });
    return f;
}
function task(f, groupId = DEFAULT_GROUP, status = 'completed', legacy = false) {
    const snapshot = legacy ? { mode: 'image.text', prompt: '旧 海边 (甲)&', inputAssets: [] } : f.store.freezeOutputDirectory({ contractVersion: 1, localRequestId: randomUUID(), model: 'synthetic', parameters: {}, mode: 'image.text', prompt: '海边 (甲)&', inputAssets: [], groupId });
    const id = randomUUID(); f.db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,execution_media_kind) VALUES(?,?,?,?,?,?)').run(id, status, 'image.text', '{}', '2026-10-27T06:32:00.000Z', 'image');
    if (legacy) f.db.prepare('UPDATE tasks SET input_snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot), id); else f.store.setTaskSnapshot(id, snapshot); return f.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}
async function output(f, row, position = 0) {
    const file = path.join(f.directory, '合成 原件&.part'); fs.writeFileSync(file, png); const metadata = await validateMedia(file, { expectedKind: 'image' });
    const asset = f.store.publishVerifiedFile(file, metadata, row.output_root_ref, { task: row, position });
    f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(row.id, asset.assetId, 'output', position);
    f.db.prepare('INSERT INTO task_download_files VALUES(?,?,?,?,?,?)').run(row.id, 'source-' + position, asset.assetId, asset.sha256, asset.byteLength, position);
    return { ...asset, file: f.store.resolveAssetPath(asset.assetId) };
}
const move = (f, row, groupId, requestId = randomUUID(), overrides) => f.moves(overrides).moveTask(row.id, { groupId, requestId });
const snapshot = (f, row) => f.db.prepare('SELECT input_snapshot_json,output_root_ref,output_directory_version_id FROM tasks WHERE id=?').get(row.id);
const crash = () => Object.assign(new Error('simulated process interruption'), { simulateCrash: true });
test('G03 whole task Unicode move copies all outputs, checkpoints and locations atomically at original root; duplicate request is stable', async t => {
    const f = await fixture(t), a = f.store.createGroup({ name: '原 剧本&' }), b = f.store.createGroup({ name: '目标 (乙)&' }), row = task(f, a.groupId), assets = [await output(f, row), await output(f, row, 1)], frozen = snapshot(f, row);
    const nextRoot = path.join(f.directory, '新的 根目录'); fs.mkdirSync(nextRoot); f.store.selectOutputDirectory(nextRoot);
    const requestId = randomUUID(), result = move(f, row, b.groupId, requestId); assert.equal(result.movedFiles, 2); assert.deepEqual(move(f, row, b.groupId, requestId), result);
    assert.deepEqual(snapshot(f, row), frozen); assert.equal(f.groups.membership(row.id).group_id, b.groupId);
    const formal = f.db.prepare("SELECT a.* FROM task_assets ta JOIN assets a ON a.id=ta.asset_id WHERE ta.task_id=? AND role='output' ORDER BY position").all(row.id);
    assert.equal(formal.length, 2); for (const asset of formal) { assert.ok(f.store.resolveAssetPath(asset.id).startsWith(fs.realpathSync.native(f.root) + path.sep)); assert.ok(asset.storage_key.startsWith('目标 (乙)&' + path.sep)); assert.deepEqual(f.store.readAsset(asset.id).bytes, png); }
    for (const asset of assets) assert.equal(fs.existsSync(asset.file), false);
    assert.deepEqual(f.db.prepare('SELECT asset_id FROM task_download_files WHERE task_id=? ORDER BY position').all(row.id).map(value => value.asset_id), formal.map(value => value.id));
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_output_locations WHERE task_id=? AND group_id=?').get(row.id, b.groupId).n, 2);
    assert.equal(f.db.prepare('SELECT state FROM group_file_operations WHERE request_id=?').get(requestId).state, 'completed'); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.throws(() => move(f, row, a.groupId, requestId), { code: 'GROUP_REQUEST_CONFLICT' });
});
test('G03 shared task inputs and group drafts retain their original IDs and source files', async t => {
    const f = await fixture(t), b = f.store.createGroup({ name: '共享归组' }), row = task(f), asset = await output(f, row), other = task(f);
    f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(other.id, asset.assetId, 'input', 0);
    f.store.putDraft('image.text', { prompt: '保留输入', model: 'fixture', parameters: {}, inputAssets: [{ assetId: asset.assetId, position: 0, role: 'reference' }], expectedRevision: 0 }, b.groupId);
    f.db.prepare('INSERT INTO workbench_submission_intents VALUES(?,?,?,NULL)').run(randomUUID(), JSON.stringify({ inputAssets: [{ assetId: asset.assetId }] }), '2026');
    const inputSnapshot = snapshot(f, other), draft = f.store.getDraft('image.text', b.groupId); move(f, row, b.groupId);
    assert.ok(fs.existsSync(asset.file)); assert.deepEqual(f.store.readAsset(asset.assetId).bytes, png); assert.deepEqual(snapshot(f, other), inputSnapshot); assert.deepEqual(f.store.getDraft('image.text', b.groupId), draft);
    assert.notEqual(f.db.prepare("SELECT asset_id FROM task_assets WHERE task_id=? AND role='output'").get(row.id).asset_id, asset.assetId);
});
test('G03 precommit copy or database failure rolls back every output and preserves membership', async t => {
    const f = await fixture(t), b = f.store.createGroup({ name: '失败回滚' }), row = task(f), assets = [await output(f, row), await output(f, row, 1)], requestId = randomUUID(); let copies = 0;
    assert.throws(() => move(f, row, b.groupId, requestId, { fault: phase => { if (phase === 'copied' && ++copies === 2) throw Object.assign(new Error('disk failure'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
    assert.equal(f.groups.membership(row.id).group_id, DEFAULT_GROUP); for (const asset of assets) assert.ok(fs.existsSync(asset.file));
    assert.deepEqual(fs.readdirSync(path.join(b.outputLocation, '图片')), []); assert.equal(f.db.prepare('SELECT state FROM group_file_operations WHERE request_id=?').get(requestId).state, 'failed');
    assert.throws(() => move(f, row, b.groupId, requestId), { code: 'ENOSPC' });
    f.db.exec("CREATE TRIGGER g03_failure BEFORE UPDATE ON task_group_memberships BEGIN SELECT RAISE(ABORT,'G03_DB_FAILURE'); END;");
    assert.throws(() => move(f, row, b.groupId), /G03_DB_FAILURE/); f.db.exec('DROP TRIGGER g03_failure'); assert.equal(f.groups.membership(row.id).group_id, DEFAULT_GROUP); assert.deepEqual(fs.readdirSync(path.join(b.outputLocation, '图片')), []);
});
test('G03 restart interruption before commit removes only owned verified copies and leaves originals', async t => {
    const f = await fixture(t), b = f.store.createGroup({ name: '重启前' }), row = task(f), asset = await output(f, row), requestId = randomUUID();
    assert.throws(() => move(f, row, b.groupId, requestId, { fault: phase => { if (phase === 'copied') throw crash(); } }), /simulated process/);
    assert.equal(f.groups.membership(row.id).group_id, DEFAULT_GROUP); assert.ok(fs.readdirSync(path.join(b.outputLocation, '图片')).length > 0);
    f.moves().recover(); assert.deepEqual(fs.readdirSync(path.join(b.outputLocation, '图片')), []); assert.ok(fs.existsSync(asset.file)); assert.equal(f.db.prepare('SELECT state FROM group_file_operations WHERE request_id=?').get(requestId).state, 'failed');
});
test('G03 restart interruption after logical commit finishes cleanup without rolling membership back', async t => {
    const f = await fixture(t), b = f.store.createGroup({ name: '重启后' }), row = task(f), asset = await output(f, row), requestId = randomUUID();
    assert.throws(() => move(f, row, b.groupId, requestId, { fault: phase => { if (phase === 'committed') throw crash(); } }), /simulated process/);
    assert.equal(f.groups.membership(row.id).group_id, b.groupId); assert.ok(fs.existsSync(asset.file));
    f.moves().recover(); assert.equal(fs.existsSync(asset.file), false); const result = move(f, row, b.groupId, requestId); assert.equal(result.movedFiles, 1);
    const current = f.db.prepare('SELECT asset_id FROM task_download_files WHERE task_id=?').get(row.id); assert.deepEqual(f.store.readAsset(current.asset_id).bytes, png);
});
test('G03 target replacement during interrupted move is preserved and blocks mutation until exact ownership is restored', async t => {
    const f = await fixture(t), b = f.store.createGroup({ name: '所有权保护' }), row = task(f), asset = await output(f, row), requestId = randomUUID();
    assert.throws(() => move(f, row, b.groupId, requestId, { fault: phase => { if (phase === 'copied') throw crash(); } }));
    const directory = path.join(b.outputLocation, '图片'), names = fs.readdirSync(directory), temporary = path.join(directory, names.find(name => name.endsWith('.part'))), target = path.join(directory, names.find(name => !name.endsWith('.part')));
    fs.unlinkSync(target); fs.writeFileSync(target, png); assert.equal(f.moves().recover().unresolved.length,1); assert.throws(() => f.moves().recover({groupId:b.groupId}), { code: 'GROUP_RECOVERY_REQUIRED' }); assert.ok(fs.existsSync(target)); assert.ok(fs.existsSync(asset.file));
    assert.throws(() => f.moves().archiveGroup(b.groupId, { archived: true }), { code: 'GROUP_RECOVERY_REQUIRED' });
    fs.unlinkSync(target); fs.linkSync(temporary, target); f.moves().recover(); assert.equal(fs.existsSync(target), false); assert.equal(f.groups.membership(row.id).group_id, DEFAULT_GROUP);
});
test('G03 missing, corrupt or conflicting files fail without changing trusted membership or user files', async t => {
    const f = await fixture(t), b = f.store.createGroup({ name: '拒绝冲突' }), row = task(f), asset = await output(f, row), target = path.join(b.outputLocation, '图片', path.basename(asset.file));
    fs.writeFileSync(target, 'user-owned'); assert.throws(() => move(f, row, b.groupId), { code: 'ASSET_FILE_CONFLICT' }); assert.equal(fs.readFileSync(target, 'utf8'), 'user-owned'); fs.unlinkSync(target);
    fs.writeFileSync(asset.file, 'corrupt'); assert.throws(() => move(f, row, b.groupId), { code: 'ASSET_CORRUPT' }); assert.equal(f.groups.membership(row.id).group_id, DEFAULT_GROUP);
    fs.unlinkSync(asset.file); assert.throws(() => move(f, row, b.groupId), { code: 'ASSET_MISSING' }); assert.equal(f.groups.membership(row.id).group_id, DEFAULT_GROUP);
});
test('G03 active, unknown and paused local tasks plus late physical IO reject while terminal no-output regroup succeeds', async t => {
    const f = await fixture(t), b = f.store.createGroup({ name: '结束再归组' });
    for (const status of ['local_queued','submitting','generating','downloading','submission_unknown','polling_paused']) { const row = task(f, DEFAULT_GROUP, status); assert.throws(() => move(f, row, b.groupId), { code: 'TASK_ACTIVE' }); }
    const terminal = task(f, DEFAULT_GROUP, 'cancelled'); assert.throws(() => move(f, terminal, b.groupId, randomUUID(), { isTaskExecutionActive: () => true }), { code: 'TASK_ACTIVE' });
    const result = move(f, terminal, b.groupId); assert.equal(result.movedFiles, 0); assert.equal(f.groups.membership(terminal.id).group_id, b.groupId);
});
test('G03 rename updates every physical root once including aliases, mutable refs and current versions; immutable snapshots remain', async t => {
    const f = await fixture(t), group = f.store.createGroup({ name: '旧 名&' }), first = task(f, group.groupId), a = await output(f, first), frozen = snapshot(f, first), oldVersion = f.groups.membership(first.id).directory_version_id;
    f.store.selectOutputDirectory(f.root); const alias = task(f, group.groupId), aa = await output(f, alias);
    const root2 = path.join(f.directory, '另一个 根 (二)&'); fs.mkdirSync(root2); f.store.selectOutputDirectory(root2); const second = task(f, group.groupId), b = await output(f, second);
    const result = f.moves().renameGroup(group.groupId, { name: '新 名(中文)&', requestId: randomUUID() }); assert.equal(result.renamedRoots, 2); assert.deepEqual(snapshot(f, first), frozen);
    assert.equal(f.db.prepare('SELECT directory_name FROM group_directory_versions WHERE id=?').get(oldVersion).directory_name, '旧 名&');
    for (const asset of [a, aa, b]) { assert.ok(f.store.resolveAssetPath(asset.assetId).includes(path.join('assets','新 名(中文)&','图片'))); assert.deepEqual(f.store.readAsset(asset.assetId).bytes, png); }
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_output_locations WHERE group_id=? AND storage_key LIKE ?').get(group.groupId, '新 名(中文)&%').n, 3);
});
test('G03 rename preflights all roots and rejects pending saved intents before touching any folder', async t => {
    const f = await fixture(t), group = f.store.createGroup({ name: '冲突原组' }), first = task(f, group.groupId); await output(f, first);
    const root2 = path.join(f.directory, '第二根'); fs.mkdirSync(root2); f.store.selectOutputDirectory(root2); task(f, group.groupId); fs.mkdirSync(path.join(root2, 'assets','冲突目标'));
    assert.throws(() => f.moves().renameGroup(group.groupId, { name: '冲突目标', requestId: randomUUID() }), { code: 'GROUP_DIRECTORY_CONFLICT' }); assert.ok(fs.existsSync(group.outputLocation));
    f.db.prepare('INSERT INTO workbench_submission_intents VALUES(?,?,?,NULL)').run(randomUUID(), JSON.stringify({ groupId: group.groupId, inputAssets: [] }), '2026');
    assert.throws(() => f.moves().renameGroup(group.groupId, { name: '新名字', requestId: randomUUID() }), { code: 'GROUP_ACTIVE' }); assert.equal(f.groups.get(group.groupId).name, '冲突原组');
});
test('G03 rename interruption rolls all renamed physical roots back while preserving immutable versions', async t => {
    const f = await fixture(t), group = f.store.createGroup({ name: '回退原名' }), first = task(f, group.groupId), asset = await output(f, first), requestId = randomUUID();
    assert.throws(() => f.moves({ fault: phase => { if (phase === 'renamed') throw crash(); } }).renameGroup(group.groupId, { name: '回退新名', requestId }), /simulated process/);
    f.moves().recover(); assert.equal(f.groups.get(group.groupId).name, '回退原名'); assert.deepEqual(f.store.readAsset(asset.assetId).bytes, png); assert.ok(fs.existsSync(group.outputLocation)); assert.equal(fs.existsSync(path.join(f.root, 'assets','回退新名')), false);
});
test('G03 archive keeps history and rejects new submissions; empty deletion retires identity and permits same display name', async t => {
    const f = await fixture(t), group = f.store.createGroup({ name: '归档保留' }), row = task(f, group.groupId), asset = await output(f, row);
    f.moves().archiveGroup(group.groupId, { archived: true }); assert.deepEqual(f.store.readAsset(asset.assetId).bytes, png); assert.throws(() => f.store.freezeOutputDirectory({ mode: 'image.text', groupId: group.groupId }), { code: 'GROUP_ARCHIVED' });
    f.moves().archiveGroup(group.groupId, { archived: false }); assert.equal(f.store.freezeOutputDirectory({ mode: 'image.text', groupId: group.groupId }).groupId, group.groupId);
    assert.throws(() => f.moves().deleteGroup(group.groupId), { code: 'GROUP_NOT_EMPTY' });
    for (const action of [() => f.moves().archiveGroup(DEFAULT_GROUP, { archived: true }), () => f.moves().renameGroup(DEFAULT_GROUP, { name: '不能', requestId: randomUUID() }), () => f.moves().deleteGroup(DEFAULT_GROUP)]) assert.throws(action, { code: 'GROUP_DEFAULT_IMMUTABLE' });
    const empty = f.store.createGroup({ name: '可重复使用' }); f.moves().deleteGroup(empty.groupId); assert.throws(() => f.groups.get(empty.groupId), { code: 'GROUP_NOT_FOUND' }); assert.equal(fs.existsSync(empty.outputLocation), false); assert.notEqual(f.store.createGroup({ name: '可重复使用' }).groupId, empty.groupId);
    const userData = f.store.createGroup({ name: '用户文件保护' }); fs.writeFileSync(path.join(userData.outputLocation,'保留.txt'), 'keep'); assert.throws(() => f.moves().deleteGroup(userData.groupId), { code: 'GROUP_NOT_EMPTY' }); assert.equal(fs.readFileSync(path.join(userData.outputLocation,'保留.txt'),'utf8'), 'keep');
});
test('G03 historical preview is read-only, explicit organization keeps original snapshot and future restore location follows current membership', async t => {
    const f = await fixture(t), row = task(f, DEFAULT_GROUP, 'completed', true), asset = f.store.importBuffer(png, { mimeType: 'image/png', sourceKind: 'generated', validation: { sha256: hash(png), width: 8, height: 8 } });
    f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(row.id, asset.assetId, 'output', 0); const frozen = snapshot(f, row), before = f.db.totalChanges;
    const preview = f.moves().previewHistory(); assert.equal(preview.total, 1); assert.equal(preview.items[0].conflicts.length, 0); assert.ok(preview.items[0].files[0].target.includes(path.join('assets','未分组','图片'))); assert.equal(f.db.totalChanges, before); assert.equal(fs.existsSync(path.join(f.root,'assets','未分组')), false);
    const requestId = randomUUID(), result = f.moves().organizeHistory({ taskIds: [row.id], requestId }); assert.equal(result.items[0].movedFiles, 1); assert.deepEqual(snapshot(f, row), frozen); assert.deepEqual(f.moves().organizeHistory({ taskIds: [row.id], requestId }), result);
    const location = f.groups.location(row, 0, 'png'); assert.equal(location.group_id, DEFAULT_GROUP); assert.ok(location.storage_key.startsWith('未分组' + path.sep)); assert.equal(f.moves().previewHistory().total, 0);
});
test('G03 own-group move on legacy output is a true no-op; only explicit history action migrates it', async t => {
    const f = await fixture(t), row = task(f, DEFAULT_GROUP, 'completed', true), asset = f.store.importBuffer(png, { mimeType: 'image/png', sourceKind: 'generated', validation: { sha256: hash(png), width: 8, height: 8 } });
    f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(row.id, asset.assetId, 'output', 0);
    const original = f.store.resolveAssetPath(asset.assetId), before = f.groups.membership(row.id).revision;
    assert.equal(move(f, row, DEFAULT_GROUP).unchanged, true); assert.equal(f.store.resolveAssetPath(asset.assetId), original); assert.equal(f.groups.membership(row.id).revision, before); assert.equal(f.db.prepare('SELECT count(*) n FROM group_file_operations').get().n, 0); assert.equal(fs.existsSync(path.join(f.root,'assets','未分组')), false);
    const organized = f.moves().organizeHistory({ taskIds: [row.id], requestId: randomUUID() }); assert.equal(organized.succeeded, 1); assert.equal(organized.items[0].movedFiles, 1);
});
test('G03 emoji group rename preserves complete path components and original snapshot', async t => {
    const f = await fixture(t), group = f.store.createGroup({ name: '海🌊' }), row = task(f, group.groupId), asset = await output(f, row), frozen = snapshot(f,row);
    f.moves().renameGroup(group.groupId, { name: '夜🌙 海边', requestId: randomUUID() }); const file = f.store.resolveAssetPath(asset.assetId); assert.ok(file.includes(path.join('assets','夜🌙 海边','图片'))); assert.deepEqual(f.store.readAsset(asset.assetId).bytes,png); assert.deepEqual(snapshot(f,row),frozen);
    assert.equal(f.groups.location(row,0,'png').storage_key.split(path.sep)[1], '图片');
});
test('G03 rename recovery rejects replacement directories before rollback and after logical commit', async t => {
    const f = await fixture(t), group = f.store.createGroup({ name: '身份原目录' }), row = task(f,group.groupId), asset = await output(f,row);
    for (const phase of ['renamed','committed']) {
        const requestId = randomUUID(), name = phase === 'renamed' ? '身份新目录' : '身份已提交';
        assert.throws(() => f.moves({ fault: event => { if(event === phase) throw crash(); } }).renameGroup(group.groupId,{name,requestId}),/simulated process/);
        const next = path.join(f.root,'assets',name), held = next + '-held'; fs.renameSync(next,held); fs.mkdirSync(next); fs.writeFileSync(path.join(next,'用户.txt'),'keep');
        assert.equal(f.moves().recover().unresolved.length,1); assert.throws(() => f.moves().recover({groupId:group.groupId}),{code:'GROUP_RECOVERY_REQUIRED'}); assert.equal(fs.readFileSync(path.join(next,'用户.txt'),'utf8'),'keep');
        fs.unlinkSync(path.join(next,'用户.txt')); fs.rmdirSync(next); fs.renameSync(held,next); f.moves().recover();
        assert.equal(f.groups.get(group.groupId).name,phase === 'renamed' ? '身份原目录' : name); assert.deepEqual(f.store.readAsset(asset.assetId).bytes,png);
    }
});
test('G03 explicit history selection reports all successes/failures and rejects request range changes', async t => {
    const f = await fixture(t), rows = [task(f,DEFAULT_GROUP,'completed',true),task(f,DEFAULT_GROUP,'completed',true)];
    for (const row of rows) { const asset = f.store.importBuffer(png,{mimeType:'image/png',sourceKind:'generated',validation:{sha256:hash(png),width:8,height:8}}); f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(row.id,asset.assetId,'output',0); }
    const missing = randomUUID(), requestId = randomUUID(), selected = [rows[0].id,missing,rows[1].id], result = f.moves().organizeHistory({taskIds:selected,requestId});
    assert.equal(result.succeeded,2); assert.equal(result.failed,1); assert.deepEqual(result.items.map(item=>item.ok),[true,false,true]); assert.equal(result.items[1].code,'TASK_NOT_FOUND'); assert.deepEqual(f.moves().organizeHistory({taskIds:selected,requestId}),result);
    assert.throws(()=>f.moves().organizeHistory({taskIds:[rows[0].id],requestId}),{code:'GROUP_REQUEST_CONFLICT'});
});
test('G03 completely cleared drafts allow empty-group deletion; saved content remains protected', async t => {
    const f = await fixture(t), group = f.store.createGroup({name:'可清空草稿'}), body = {prompt:'有内容',model:'fixture',parameters:{},inputAssets:[],expectedRevision:0};
    f.store.putDraft('image.text',body,group.groupId); assert.throws(()=>f.moves().deleteGroup(group.groupId),{code:'GROUP_NOT_EMPTY'});
    f.store.putDraft('image.text',{...body,prompt:'',model:'',expectedRevision:1},group.groupId); f.moves().deleteGroup(group.groupId); assert.throws(()=>f.groups.get(group.groupId),{code:'GROUP_NOT_FOUND'});
});
test('G03 missing partial checkpoint is invalidated on regroup; reappearing old inline file restores through current location', async t => {
    const f = await fixture(t), group = f.store.createGroup({name:'部分结果的新组'}), row = task(f,DEFAULT_GROUP,'download_failed'), assets = [await output(f,row),await output(f,row,1)];
    f.db.prepare("DELETE FROM task_assets WHERE task_id=? AND role='output'").run(row.id); fs.unlinkSync(assets[1].file);
    const result = move(f,row,group.groupId); assert.equal(result.movedFiles,1); assert.equal(f.db.prepare('SELECT 1 FROM task_download_files WHERE task_id=? AND source_key=?').get(row.id,'source-1'),undefined);
    fs.writeFileSync(assets[1].file,png); const reused = [];
    const worker = createDownloadWorker({store:f.store,connections:{getAuth:()=>({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic-only'})},fetchImpl:async()=>{throw Error('unexpected network');}});
    const proof = await worker(row,assets.map((asset,position)=>({kind:'asset',assetId:asset.assetId,sourceKey:'source-'+position,mediaKind:'image'})),{
        readCheckpoint:source=>{const checkpoint=f.db.prepare('SELECT * FROM task_download_files WHERE task_id=? AND source_key=?').get(row.id,source.sourceKey);if(!checkpoint)return null;reused.push(source.sourceKey);return {assetId:checkpoint.asset_id,byteLength:checkpoint.byte_length};},
        saveCheckpoint:(source,position,assetId)=>{const asset=f.store.getAsset(assetId);f.db.prepare('INSERT INTO task_download_files VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,source_key) DO UPDATE SET asset_id=excluded.asset_id').run(row.id,source.sourceKey,assetId,asset.sha256,asset.byteLength,position);}
    });
    assert.deepEqual(reused,['source-0']); assert.equal(proof.assetIds.length,2); for(const assetId of proof.assetIds)assert.ok(f.store.resolveAssetPath(assetId).includes(path.join('assets','部分结果的新组','图片'))); assert.ok(fs.existsSync(assets[1].file));
});
test('G03 unresolved recovery blocks source and target groups while startup, read-only history and unrelated groups remain usable', async t => {
    const f = await fixture(t), a = f.store.createGroup({name:'受影响原组'}), b = f.store.createGroup({name:'受影响目标'}), c = f.store.createGroup({name:'可继续组'}), row = task(f,a.groupId); await output(f,row);
    assert.throws(()=>move(f,row,b.groupId,randomUUID(),{fault:phase=>{if(phase==='copied')throw crash();}}));
    const directory=path.join(b.outputLocation,'图片'), target=path.join(directory,fs.readdirSync(directory).find(name=>!name.endsWith('.part')));fs.unlinkSync(target);fs.writeFileSync(target,png);
    assert.equal(f.moves().recover().unresolved.length,1); assert.ok(f.store.getTask(row.id)); assert.ok(f.moves().previewHistory());
    for(const groupId of [a.groupId,b.groupId])assert.throws(()=>f.moves().recover({groupId}),{code:'GROUP_RECOVERY_REQUIRED'});
    assert.equal(f.moves().recover({groupId:c.groupId}).unresolved.length,1); f.moves().archiveGroup(c.groupId,{archived:true}); assert.equal(f.groups.get(c.groupId).archived_at!==null,true);
});
test('G03 isolated pending intent, recovery candidate, immutable snapshot and legacy link each independently retain source', async t => {
    const f = await fixture(t), group = f.store.createGroup({name:'引用逐项保护'});
    for(const reference of ['intent','candidate','snapshot','legacy']) {
        const row=task(f),asset=await output(f,row);
        if(reference==='intent')f.db.prepare('INSERT INTO workbench_submission_intents VALUES(?,?,?,NULL)').run(randomUUID(),JSON.stringify({inputAssets:[{assetId:asset.assetId}]}),'2026');
        if(reference==='candidate'){const other=task(f);f.db.prepare('UPDATE tasks SET result_sources_json=? WHERE id=?').run(JSON.stringify([{kind:'asset',assetId:asset.assetId}]),other.id);}
        if(reference==='snapshot'){const other=randomUUID();f.db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,input_snapshot_json) VALUES(?,?,?,?,?,?)').run(other,'cancelled','image.text','{}','2026-10-27',JSON.stringify({inputAssets:[{assetId:asset.assetId}]}));}
        if(reference==='legacy')f.db.prepare('INSERT INTO asset_legacy_links VALUES(?,?,?)').run('image','keep-'+randomUUID()+'.png',asset.assetId);
        move(f,row,group.groupId);assert.ok(fs.existsSync(asset.file),reference);assert.deepEqual(f.store.readAsset(asset.assetId).bytes,png,reference);
    }
});
test('G03 pure recovery status and history preview do not repair files; canonical UUID casing cannot bypass recovery guards', async t => {
    const f=await fixture(t),a=f.store.createGroup({name:'大小写原组'}),b=f.store.createGroup({name:'大小写目标'}),row=task(f,a.groupId);await output(f,row);
    assert.throws(()=>f.moves({fault:phase=>{if(phase==='copied')throw crash();}}).moveTask(row.id.toUpperCase(),{groupId:b.groupId.toUpperCase(),requestId:randomUUID()}));
    const directory=path.join(b.outputLocation,'图片'),before=fs.readdirSync(directory);assert.deepEqual(f.moves().recoveryStatus(),{unresolved:[]});f.moves().previewHistory();assert.deepEqual(fs.readdirSync(directory),before);
    const target=path.join(directory,before.find(name=>!name.endsWith('.part')));fs.unlinkSync(target);fs.writeFileSync(target,png);f.moves().recover();assert.throws(()=>f.moves().archiveGroup(b.groupId.toUpperCase(),{archived:true}),{code:'GROUP_RECOVERY_REQUIRED'});
    assert.ok(f.moves().recoveryStatus().unresolved[0].groupIds.includes(b.groupId));
});
test('G03 rename rejects active other-group input/checkpoint/candidate/physical aliases and pending input intents', async t => {
    const f=await fixture(t),a=f.store.createGroup({name:'共享素材目录'}),b=f.store.createGroup({name:'引用者所在组'}),source=task(f,a.groupId),asset=await output(f,source);
    const attempt=()=>f.moves().renameGroup(a.groupId,{name:'安全新名',requestId:randomUUID()});
    for(const kind of ['input','checkpoint','candidate','alias']) {
        const reader=task(f,b.groupId,'generating');let referenced=asset.assetId;
        if(kind==='alias') {
            f.store.selectOutputDirectory(f.root);const aliasRoot=f.store.outputDirectory().outputRootRef;f.groups.ensure(a.groupId,aliasRoot);const original=f.db.prepare('SELECT * FROM assets WHERE id=?').get(asset.assetId);referenced=randomUUID();
            f.db.prepare('INSERT INTO assets SELECT ?,kind,storage_key,display_name,mime_type,byte_length,sha256,width,height,duration_seconds,source_kind,validation_state,availability,created_at,?,group_id FROM assets WHERE id=?').run(referenced,aliasRoot,original.id);
        }
        if(kind==='input'||kind==='alias')f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(reader.id,referenced,'input',0);
        if(kind==='checkpoint')f.db.prepare('INSERT INTO task_download_files VALUES(?,?,?,?,?,?)').run(reader.id,'reader-source',referenced,asset.sha256,asset.byteLength,0);
        if(kind==='candidate')f.db.prepare('UPDATE tasks SET result_sources_json=? WHERE id=?').run(JSON.stringify([{kind:'asset',assetId:referenced}]),reader.id);
        assert.throws(attempt,{code:'GROUP_ACTIVE'});f.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(reader.id);
    }
    const intent=randomUUID();f.db.prepare('INSERT INTO workbench_submission_intents VALUES(?,?,?,NULL)').run(intent,JSON.stringify({groupId:b.groupId,inputAssets:[{assetId:asset.assetId}]}),'2026');assert.throws(attempt,{code:'GROUP_ACTIVE'});f.db.prepare('DELETE FROM workbench_submission_intents WHERE local_request_id=?').run(intent);
    assert.throws(()=>f.moves({isTaskExecutionActive:taskId=>taskId!==source.id}).renameGroup(a.groupId,{name:'安全新名',requestId:randomUUID()}),{code:'GROUP_ACTIVE'});
    attempt();assert.ok(f.store.resolveAssetPath(asset.assetId).includes(path.join('assets','安全新名','图片')));
});
