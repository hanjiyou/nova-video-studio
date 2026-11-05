'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto'), Database = require('better-sqlite3');
const { migrateDatabase } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
const { createGroups, DEFAULT_GROUP, safeFile } = require('../storage/groups');
const { createOutputDirectories } = require('../storage/output-directories');
const { createGroupMoves } = require('../storage/group-moves');
const { validateMedia } = require('../storage/media-validator');
const { normalizeWorkName, outputFilename } = require('../storage/work-names');
const { createAssetActions } = require('../../desktop/asset-actions.cjs');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1/reference-a.png'));
async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-work-name-')), dbPath = path.join(directory, 'tasks.sqlite'), db = new Database(dbPath), root = path.join(directory, '中文 根&');
    t.after(() => { if (db.open) db.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });
    await migrateDatabase({ db, dbPath });
    const store = createWorkbenchStore({ db, rootDirectory: root }), outputDirectories = createOutputDirectories({ db, defaultDirectory: root }), groups = createGroups({ db, outputDirectories });
    const f = { directory, root, db, dbPath, store, outputDirectories, groups };
    f.moves = overrides => createGroupMoves({ db, groups, outputDirectories, trustedPath: asset => { try { return store.resolveAssetPath(asset.id); } catch (cause) { if (['ASSET_MISSING','ASSET_NOT_FOUND'].includes(cause.code)) return null; throw cause; } }, ...overrides });
    return f;
}
function task(f, { workName, legacy = false, status = 'completed', count = 1 } = {}) {
    const input = { contractVersion: 1, localRequestId: randomUUID(), model: 'synthetic', parameters: {}, mode: 'image.text', prompt: '海边 (甲)&', inputAssets: [], ...(workName === undefined ? {} : { workName }) };
    const snapshot = legacy ? input : f.store.freezeOutputDirectory(input), id = randomUUID();
    f.db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,execution_media_kind,result_sources_json) VALUES(?,?,?,?,?,?,?)').run(id, status, 'image.text', '{}', '2026-11-05T06:32:00.000Z', 'image', count > 1 ? JSON.stringify(Array.from({ length: count }, () => ({ kind: 'remote' }))) : null);
    if (legacy) f.db.prepare('UPDATE tasks SET input_snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot), id); else f.store.setTaskSnapshot(id, snapshot);
    return f.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}
async function output(f, row, position = 0) {
    const file = path.join(f.directory, '合成.part'); fs.writeFileSync(file, png); const metadata = await validateMedia(file, { expectedKind: 'image' });
    const asset = f.store.publishVerifiedFile(file, metadata, row.output_root_ref, { task: row, position });
    f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(row.id, asset.assetId, 'output', position);
    f.db.prepare('INSERT INTO task_download_files VALUES(?,?,?,?,?,?)').run(row.id, 'source-' + position, asset.assetId, asset.sha256, asset.byteLength, position);
    return { ...asset, file: f.store.resolveAssetPath(asset.assetId), metadata, original: file };
}
const input = (name, expectedNameRevision = 0, requestId = randomUUID()) => ({ workName: name, expectedNameRevision, requestId });
const rename = (f, row, name, revision = 0, overrides) => f.moves(overrides).renameTaskWork(row.id, input(name, revision));
const outputs = (f, row) => f.store.getTask(row.id).outputAssets;
const crash = () => Object.assign(new Error('simulated interruption'), { simulateCrash: true });

test('work name validation counts Unicode characters, trims and rejects control/isolated surrogate input', () => {
    assert.equal(normalizeWorkName('  中文/场景：✨  '), '中文/场景：✨'); assert.equal(normalizeWorkName('😀'.repeat(60)), '😀'.repeat(60));
    for (const value of [null, 1, {}, 'x\n', 'x\0', '\ud800', '😀'.repeat(61)]) assert.throws(() => normalizeWorkName(value), { code: 'WORK_NAME_INVALID' });
});
test('readable output names preserve real extension, stable stamp and suffix while sanitizing/cropping only the name', () => {
    const base = { taskId: randomUUID(), createdAt: '2026-11-05T06:32:00Z', ext: 'mp4', workName: 'CON.txt/镜头:😀' };
    const first = outputFilename(base); assert.match(first, /^_CON\.txt 镜头 😀_\d{8}-\d{6}_[a-f0-9]{12}\.mp4$/);
    const dateNamed = outputFilename({ ...base, workName: '20200101-000000_人物' });
    const second = outputFilename({ ...base, workName: '新名字', existingFilename: dateNamed, existingNamed: true });
    assert.equal(dateNamed.match(/_(\d{8}-\d{6})_[a-f0-9]{12}/)[1], second.match(/_(\d{8}-\d{6})_[a-f0-9]{12}/)[1]);
    const long = outputFilename({ ...base, workName: '😀'.repeat(60), directory: 'd'.repeat(170), count: 2 });
    assert.ok(long.length <= 69); assert.match(long, /_01\.mp4$/); assert.ok(!/[\p{Cs}]/u.test(long));
    assert.throws(() => outputFilename({ ...base, directory: 'd'.repeat(220) }), { code: 'PATH_TOO_LONG' });
    const numbered = outputFilename({ ...base, count: 2 });
    assert.match(outputFilename({ ...base, workName: '后续名称', count: 1, existingFilename: numbered, existingNamed: true }), /_01\.mp4$/);
    assert.ok(!outputFilename({ ...base, workName: '后续名称', count: 2, existingFilename: first, existingNamed: true }).endsWith('_01.mp4'));
});
test('new named same-second outputs use distinct stable names, numbered multi-outputs and reuse allocated locations', async t => {
    const f = await fixture(t), a = task(f, { workName: '海边', count: 2 }), b = task(f, { workName: '海边' });
    const first = await output(f, a), second = await output(f, a, 1), other = await output(f, b);
    assert.match(path.basename(first.file), /^海边_.*_01\.png$/); assert.match(path.basename(second.file), /^海边_.*_02\.png$/); assert.notEqual(first.file, other.file);
    assert.equal(f.store.publishVerifiedFile(first.original, first.metadata, a.output_root_ref, { task: a, position: 0 }).assetId, first.assetId);
    const collisionTask = task(f, { workName: '碰撞' }), location = f.groups.membership(collisionTask.id), directory = path.join(f.root, 'assets', location.directory_name, '图片');
    const target = path.join(directory, outputFilename({ taskId: collisionTask.id, createdAt: collisionTask.created_at, ext: 'png', workName: '碰撞' }));
    fs.writeFileSync(target, 'external'); const saved = await output(f, collisionTask); assert.match(saved.file, /_1\.png$/); assert.equal(fs.readFileSync(target, 'utf8'), 'external');
});
test('whole task rename updates all files/checkpoints/current title while freezing submitted inputs and group identity', async t => {
    const f = await fixture(t), row = task(f, { workName: '初始', count: 2 }), original = [await output(f, row), await output(f, row, 1)];
    const frozen = f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(row.id), membership = f.groups.membership(row.id), request = input('场景/一:推进');
    const result = f.moves().renameTaskWork(row.id, request); assert.equal(result.renamedFiles, 2); assert.deepEqual(f.moves().renameTaskWork(row.id, request), result);
    const current = f.store.getTask(row.id); assert.equal(current.workName, '场景/一:推进'); assert.equal(current.submittedWorkName, '初始'); assert.equal(current.nameRevision, 1);
    assert.deepEqual(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(row.id), frozen); assert.deepEqual(f.groups.membership(row.id), membership);
    for (const asset of current.outputAssets) { assert.match(asset.displayName, /^场景 一 推进_/); assert.deepEqual(f.store.readAsset(asset.assetId).bytes, png); }
    for (const asset of original) assert.equal(fs.existsSync(asset.file), false);
    assert.throws(() => f.moves().renameTaskWork(row.id, { ...request, workName: '篡改' }), { code: 'WORK_NAME_REQUEST_CONFLICT' });
    assert.throws(() => rename(f, row, '迟到'), { code: 'WORK_NAME_REVISION_CONFLICT' });
    const next = rename(f, row, '再改名', 1); assert.equal(next.nameRevision, 2); assert.match(outputs(f, row)[0].displayName, /_01\.png$/); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
test('legacy add-name stays in its original digest directory, is explicitly readable and re-download reuses the renamed asset', async t => {
    const f = await fixture(t), row = task(f, { legacy: true }), asset = await output(f, row), directory = path.dirname(asset.file);
    rename(f, row, '旧作品补名'); const next = outputs(f, row)[0], file = f.store.resolveAssetPath(next.assetId);
    assert.equal(path.dirname(file), directory); assert.match(path.basename(file), /^旧作品补名_/); assert.equal(fs.existsSync(asset.file), false);
    const record = f.db.prepare('SELECT * FROM assets WHERE id=?').get(next.assetId); assert.equal(record.named_legacy, 1); assert.equal(record.group_id, null);
    const canonicalAssets = fs.realpathSync.native(path.join(f.root, 'assets'));
    assert.throws(() => safeFile(canonicalAssets, record.storage_key), { code: 'ASSET_PATH_REJECTED' });
    assert.equal(safeFile(canonicalAssets, record.storage_key, false, true), file);
    fs.unlinkSync(file); const restored = f.store.publishVerifiedFile(asset.original, asset.metadata, row.output_root_ref, { task: row, position: 0 }); assert.equal(restored.assetId, next.assetId); assert.equal(f.store.resolveAssetPath(next.assetId), file);
    rename(f, row, '修改旧作品', 1); assert.match(outputs(f, row)[0].displayName, /^修改旧作品_/); assert.equal(path.dirname(f.store.resolveAssetPath(outputs(f, row)[0].assetId)), directory);
});
test('shared inputs, group drafts, pending intents and result candidates keep old IDs and files', async t => {
    const f = await fixture(t), row = task(f), asset = await output(f, row), other = task(f), group = f.store.createGroup({ name: '草稿引用' });
    f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(other.id, asset.assetId, 'input', 0);
    f.store.putDraft('image.text', { prompt: '引用', model: 's', parameters: {}, inputAssets: [{ assetId: asset.assetId, position: 0, role: 'reference' }], expectedRevision: 0 }, group.groupId);
    f.db.prepare('INSERT INTO workbench_submission_intents VALUES(?,?,?,NULL)').run(randomUUID(), JSON.stringify({ inputAssets: [{ assetId: asset.assetId }] }), '2026');
    f.db.prepare('UPDATE tasks SET result_sources_json=? WHERE id=?').run(JSON.stringify([{ kind: 'asset', assetId: asset.assetId }]), other.id);
    rename(f, row, '独立作品名称'); assert.ok(fs.existsSync(asset.file)); assert.deepEqual(f.store.readAsset(asset.assetId).bytes, png); assert.notEqual(outputs(f, row)[0].assetId, asset.assetId);
    assert.equal(f.store.getDraft('image.text', group.groupId).inputAssets[0].assetId, asset.assetId); assert.equal(f.store.getTask(other.id).inputAssets[0].assetId, asset.assetId);
});
test('multi-file failure before commit rolls every copy back and preserves name/version/originals', async t => {
    const f = await fixture(t), row = task(f, { workName: '原名', count: 2 }), originals = [await output(f, row), await output(f, row, 1)]; let copied = 0;
    assert.throws(() => rename(f, row, '不应成功', 0, { fault: phase => { if (phase === 'copied' && ++copied === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } }), { code: 'DISK_FULL', statusCode: 409 });
    assert.equal(f.store.getTask(row.id).workName, '原名'); assert.equal(f.store.getTask(row.id).nameRevision, 0);
    for (const asset of originals) assert.ok(fs.existsSync(asset.file)); assert.equal(fs.readdirSync(path.dirname(originals[0].file)).some(name => name.startsWith('不应成功') || name.endsWith('.part')), false);
});
test('restart before commit rolls back copies; restart after commit finishes cleanup without reverting new name', async t => {
    const f = await fixture(t), row = task(f, { workName: '原名' }), asset = await output(f, row);
    assert.throws(() => rename(f, row, '重启前', 0, { fault: phase => { if (phase === 'copied') throw crash(); } }), /simulated/);
    f.moves().recover(); assert.equal(f.store.getTask(row.id).workName, '原名'); assert.ok(fs.existsSync(asset.file));
    assert.throws(() => rename(f, row, '重启后', 0, { fault: phase => { if (phase === 'committed') throw crash(); } }), /simulated/);
    assert.equal(f.store.getTask(row.id).workName, '重启后'); assert.ok(fs.existsSync(asset.file)); f.moves().recover(); assert.equal(fs.existsSync(asset.file), false);
    assert.deepEqual(f.store.readAsset(outputs(f, row)[0].assetId).bytes, png);
});
test('post-commit cleanup failure reports committed name with cleanupPending and same-request replay remains truthful', async t => {
    const f = await fixture(t), row = task(f, { workName: '原名' }), asset = await output(f, row), request = input('已经提交');
    const unlink = fs.unlinkSync; fs.unlinkSync = file => { if (file === asset.file) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return unlink(file); };
    try {
        const result = f.moves().renameTaskWork(row.id, request); assert.equal(result.cleanupPending, true); assert.equal(f.store.getTask(row.id).workName, '已经提交'); assert.ok(fs.existsSync(asset.file));
        assert.equal(f.moves().renameTaskWork(row.id, request).cleanupPending, true); assert.deepEqual(f.store.readAsset(outputs(f, row)[0].assetId).bytes, png);
    } finally { fs.unlinkSync = unlink; }
    f.moves().recover(); assert.equal(fs.existsSync(asset.file), false); assert.equal(f.moves().renameTaskWork(row.id, request).cleanupPending, undefined);
});
test('interrupted target replacement is never deleted and only ownership restoration permits rollback', async t => {
    const f = await fixture(t), row = task(f), asset = await output(f, row);
    assert.throws(() => rename(f, row, '新目标', 0, { fault: phase => { if (phase === 'copied') throw crash(); } }));
    const directory = path.dirname(asset.file), names = fs.readdirSync(directory), temp = path.join(directory, names.find(name => name.endsWith('.part'))), target = path.join(directory, names.find(name => name.startsWith('新目标')));
    fs.unlinkSync(target); fs.writeFileSync(target, png); assert.equal(f.moves().recover().unresolved.length, 1); assert.ok(fs.existsSync(target)); assert.ok(fs.existsSync(asset.file));
    fs.unlinkSync(target); fs.linkSync(temp, target); f.moves().recover(); assert.equal(fs.existsSync(target), false); assert.equal(f.store.getTask(row.id).workName, '');
});
test('missing/corrupt files and active IO reject rename, terminal failed task with no output accepts a name', async t => {
    const f = await fixture(t), row = task(f), asset = await output(f, row); fs.writeFileSync(asset.file, 'corrupt');
    assert.throws(() => rename(f, row, '失败'), { code: 'ASSET_CORRUPT' }); fs.unlinkSync(asset.file); assert.throws(() => rename(f, row, '失败'), { code: 'ASSET_MISSING' }); assert.equal(f.store.getTask(row.id).workName, '');
    for (const status of ['submitting', 'generating', 'downloading', 'submission_unknown', 'polling_paused']) assert.throws(() => rename(f, task(f, { status }), '等待'), { code: 'TASK_ACTIVE' });
    const terminal = task(f, { status: 'failed' }); assert.throws(() => rename(f, terminal, '等待IO', 0, { isTaskExecutionActive: () => true }), { code: 'TASK_ACTIVE' });
    assert.equal(rename(f, terminal, '失败也有名字').renamedFiles, 0); assert.equal(f.store.getTask(terminal.id).workName, '失败也有名字');
});
test('no-op requests are durable and clearing a name restores prompt-derived file naming', async t => {
    const f = await fixture(t), row = task(f, { workName: '名称' }), asset = await output(f, row), request = input('名称');
    const result = f.moves().renameTaskWork(row.id, request); assert.equal(result.unchanged, true); assert.equal(result.nameRevision, 0);
    assert.throws(() => f.moves().renameTaskWork(row.id, { ...request, workName: '不同' }), { code: 'WORK_NAME_REQUEST_CONFLICT' });
    rename(f, row, ''); assert.equal(f.store.getTask(row.id).workName, ''); assert.match(outputs(f, row)[0].displayName, /^\d{8}-\d{6}_海边/); assert.equal(fs.existsSync(asset.file), false);
});
test('legacy add-name then regroup then rename and restore retains current filename and strict references', async t => {
    const f = await fixture(t), row = task(f, { legacy: true }), original = await output(f, row), target = f.store.createGroup({ name: '新分组' });
    rename(f, row, '补名'); const named = outputs(f, row)[0].displayName;
    f.moves().moveTask(row.id, { groupId: target.groupId, requestId: randomUUID() }); assert.equal(outputs(f, row)[0].displayName, named);
    rename(f, row, '移动后改名', 1); const asset = outputs(f, row)[0], file = f.store.resolveAssetPath(asset.assetId); assert.ok(file.includes(path.join('新分组', '图片'))); fs.unlinkSync(file);
    const restored = f.store.publishVerifiedFile(original.original, original.metadata, row.output_root_ref, { task: row, position: 0 }); assert.equal(restored.assetId, asset.assetId); assert.equal(f.store.resolveAssetPath(asset.assetId), file);
});
test('save-copy uses current verified task name and denies unrelated task associations before opening a dialog', async t => {
    const f = await fixture(t), row = task(f, { workName: '20200101-000000_旧名' }), asset = await output(f, row); rename(f, row, '另存 名称');
    const next = outputs(f, row)[0]; let shown;
    const actions = createAssetActions({ getStore: () => f.store, getWindow: () => null, shell: {}, dialog: { showSaveDialog: async (_window, options) => { shown = options; return { canceled: true }; } } });
    assert.equal((await actions.save(next.assetId, row.id)).cancelled, true); assert.match(shown.defaultPath, /^另存 名称_/); assert.ok(shown.properties.includes('showOverwriteConfirmation'));
    shown = null; await assert.rejects(actions.save(next.assetId, task(f).id), { code: 'ASSET_TASK_MISMATCH' }); assert.equal(shown, null);
    await actions.save(next.assetId); assert.equal(shown.defaultPath, next.displayName);
});

test('physical alias references independently preserve the source during a work rename', async t => {
    const f = await fixture(t), row = task(f), original = await output(f, row), other = task(f), aliasId = randomUUID();
    f.store.selectOutputDirectory(f.root); const aliasRoot = f.store.outputDirectory().outputRootRef; f.groups.ensure(DEFAULT_GROUP, aliasRoot);
    f.db.prepare('INSERT INTO assets(id,kind,storage_key,display_name,mime_type,byte_length,sha256,width,height,duration_seconds,source_kind,validation_state,availability,created_at,root_ref,group_id,named_legacy) SELECT ?,kind,storage_key,display_name,mime_type,byte_length,sha256,width,height,duration_seconds,source_kind,validation_state,availability,created_at,?,group_id,named_legacy FROM assets WHERE id=?').run(aliasId, aliasRoot, original.assetId);
    f.db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(other.id, aliasId, 'input', 0);
    rename(f, row, '别名安全'); assert.ok(fs.existsSync(original.file)); assert.deepEqual(f.store.readAsset(aliasId).bytes, png); assert.notEqual(outputs(f, row)[0].assetId, original.assetId);
});
test('known filesystem failures expose safe 409 classifications after rollback through the store boundary', async t => {
    const f = await fixture(t), row = task(f, { workName: '原名' }), asset = await output(f, row), copy = fs.copyFileSync;
    for (const [code, expected] of [['EPERM', 'FILE_BUSY'], ['ENOSPC', 'DISK_FULL']]) {
        fs.copyFileSync = () => { throw Object.assign(new Error('private-path-must-not-leak'), { code }); };
        try { assert.throws(() => f.store.renameTaskWork(row.id, input('失败新名')), error => error.code === expected && error.statusCode === 409 && !error.message.includes('private-path')); }
        finally { fs.copyFileSync = copy; }
        assert.equal(f.store.getTask(row.id).workName, '原名'); assert.ok(fs.existsSync(asset.file));
    }
});
