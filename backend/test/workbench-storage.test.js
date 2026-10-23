'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const { migrateDatabase, MIGRATIONS, BASE_SCHEMA } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
const { createMediaStore } = require('../plugin-runtime/media');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1', name));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t, { legacy = false } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-storage-'));
    const dbPath = path.join(directory, 'tasks.sqlite');
    const db = new Database(dbPath);
    t.after(() => { if (db.open)
        db.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    if (legacy)
        db.exec(BASE_SCHEMA);
    const upgrade = async (migrations) => migrateDatabase({ db, dbPath, ...(migrations ? { migrations } : {}) });
    if (!legacy)
        await upgrade();
    const store = () => createWorkbenchStore({ db, rootDirectory: path.join(directory, 'storage') });
    return { directory, dbPath, db, upgrade, store };
}
function task(db, id = randomUUID(), status = 'completed', prompt = '原始\n"台词"') {
    db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(id, status, 'text-to-image', JSON.stringify({ model: 'fixture', prompt, images: [] }), new Date().toISOString(), '2000-01-01T00:00:00.000Z');
    return id;
}
const refs = assets => assets.map((asset, position) => ({ assetId: asset.assetId, position, role: 'reference' }));
test('schema versions apply once, backup is independently readable, unchanged restart makes no new backup', async (t) => {
    const f = await setup(t);
    const history = f.db.prepare('SELECT version,backup_file FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(history.map(row => row.version), [1, 2]);
    assert.equal(new Set(history.map(row => row.backup_file)).size, 1);
    const backupFile = path.join(f.directory, 'backups', history[0].backup_file);
    const backup = new Database(backupFile, { readonly: true, fileMustExist: true });
    assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
    backup.close();
    const manifest = JSON.parse(fs.readFileSync(backupFile + '.json', 'utf8'));
    assert.equal(manifest.sha256, sha(fs.readFileSync(backupFile)));
    const before = fs.readdirSync(path.join(f.directory, 'backups'));
    assert.deepEqual((await f.upgrade()).applied, []);
    assert.deepEqual(fs.readdirSync(path.join(f.directory, 'backups')), before);
});
test('upgrade preserves existing custom-app rows/status/TTL and consistent backup includes committed WAL data', async (t) => {
    const f = await setup(t, { legacy: true });
    f.db.pragma('journal_mode = WAL');
    const id = task(f.db, randomUUID(), 'processing');
    assert.ok(fs.statSync(f.dbPath + '-wal').size > 0);
    const before = f.db.prepare('SELECT * FROM tasks').all();
    const result = await f.upgrade();
    const after = f.db.prepare('SELECT id,status,mode,request_json,created_at,expires_at FROM tasks').all();
    assert.deepEqual(after, before.map(({ id, status, mode, request_json, created_at, expires_at }) => ({ id, status, mode, request_json, created_at, expires_at })));
    const backup = new Database(result.backupFile, { readonly: true });
    assert.equal(backup.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'processing');
    backup.close();
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM task_events WHERE type='legacy_record_retained'").get().n, 1);
});
test('failed multi-step upgrade rolls all DDL/data/history back and leaves consistent pre-upgrade backup', async (t) => {
    const f = await setup(t);
    const id = task(f.db);
    const old = f.db.prepare('SELECT * FROM tasks').all();
    const future = [...MIGRATIONS, { version: 3, name: 'test-stage', sql: "CREATE TABLE test_staged(x);UPDATE tasks SET status='changed';" }, { version: 4, name: 'test-fail', sql: 'THIS IS NOT VALID SQL;' }];
    let failure;
    try {
        await f.upgrade(future);
    }
    catch (error) {
        failure = error;
    }
    assert.equal(failure.code, 'STORAGE_MIGRATION_FAILED');
    assert.ok(fs.existsSync(failure.backupFile));
    assert.deepEqual(f.db.prepare('SELECT * FROM tasks').all(), old);
    assert.deepEqual(f.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }, { version: 2 }]);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='test_staged'").get(), undefined);
    const backup = new Database(failure.backupFile, { readonly: true });
    assert.equal(backup.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'completed');
    backup.close();
});
test('unknown/corrupted migration history fails closed without creating a new backup', async (t) => {
    const f = await setup(t);
    const count = fs.readdirSync(path.join(f.directory, 'backups')).length;
    f.db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=2').run('tampered');
    await assert.rejects(f.upgrade(), { code: 'MIGRATION_HISTORY_MISMATCH' });
    assert.equal(fs.readdirSync(path.join(f.directory, 'backups')).length, count);
});
test('existing unknown database schema is not cleared or overwritten on upgrade failure', async (t) => {
    const f = await setup(t, { legacy: true });
    f.db.exec('ALTER TABLE tasks ADD COLUMN local_request_id TEXT; CREATE TABLE private_extension(value); INSERT INTO private_extension VALUES(42);');
    await assert.rejects(f.upgrade(), { code: 'STORAGE_MIGRATION_FAILED' });
    assert.equal(f.db.prepare('SELECT value FROM private_extension').get().value, 42);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='assets'").get(), undefined);
});
test('native file import copies exact JPEG/PNG bytes and survives moving the selected source', async (t) => {
    const f = await setup(t);
    const store = f.store();
    for (const name of ['reference-a.png', 'reference-single.jpg']) {
        const source = path.join(f.directory, 'source-' + name);
        const bytes = fixture(name);
        fs.writeFileSync(source, bytes);
        const asset = store.importFile(source);
        assert.equal(asset.sha256, sha(bytes));
        assert.equal(asset.byteLength, bytes.length);
        assert.equal(JSON.stringify(asset).includes(source), false);
        fs.renameSync(source, source + '.moved');
        assert.deepEqual(store.readAsset(asset.assetId).bytes, bytes);
        assert.ok(asset.previewUrl.startsWith('/api/nova/assets/'));
    }
});
test('content-addressed assets reuse one identity and preserve original bytes and reference order', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const a = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    const b = store.importBuffer(fixture('reference-b.png'), { mimeType: 'image/png' });
    const again = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png', displayName: 'same.png' });
    assert.equal(a.assetId, again.assetId);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM assets').get().n, 2);
    const id = task(f.db);
    store.bindTaskAssets(id, refs([b, a, b]));
    assert.deepEqual(store.taskAssets(id).map(asset => asset.assetId), [b.assetId, a.assetId, b.assetId]);
    assert.equal(store.countReferences(b.assetId), 2);
    assert.throws(() => store.bindTaskAssets(id, [{ assetId: a.assetId, position: 1, role: 'reference' }]), { code: 'INVALID_ASSET_ORDER' });
});
test('unknown object-file collisions are preserved and failed publication creates no asset row', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const bytes = fixture('reference-a.png');
    const hash = sha(bytes);
    const directory = path.join(f.directory, 'storage/assets', hash.slice(0, 2));
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, hash + '.png');
    fs.writeFileSync(file, 'unknown user data');
    assert.throws(() => store.importBuffer(bytes, { mimeType: 'image/png' }), { code: 'ASSET_FILE_CONFLICT' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'unknown user data');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM assets').get().n, 0);
});
test('missing media retains metadata, task associations and draft references', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const asset = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    const id = task(f.db);
    store.bindTaskAssets(id, refs([asset]));
    store.putDraft('video.single_reference', { prompt: 'draft', model: 'fixture', parameters: {}, inputAssets: refs([asset]) });
    fs.unlinkSync(store.resolveAssetPath(asset.assetId));
    assert.equal(store.getAsset(asset.assetId).availability, 'missing');
    assert.throws(() => store.readAsset(asset.assetId), { code: 'ASSET_MISSING' });
    assert.equal(store.getTask(id).inputAssets[0].availability, 'missing');
    assert.equal(store.getDraft('video.single_reference').inputAssets[0].assetId, asset.assetId);
    assert.equal(store.countReferences(asset.assetId), 2);
});
test('tampered media is rejected by digest without deleting metadata or content', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const asset = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    const file = store.resolveAssetPath(asset.assetId);
    fs.writeFileSync(file, 'tampered');
    assert.throws(() => store.readAsset(asset.assetId), { code: 'ASSET_CORRUPT' });
    assert.equal(store.getAsset(asset.assetId).availability, 'corrupt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'tampered');
});
test('asset IDs cannot resolve traversal paths even when a database path is corrupted', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const asset = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    assert.throws(() => store.readAsset('../private'), { code: 'INVALID_ID' });
    f.db.prepare('UPDATE assets SET storage_key=? WHERE id=?').run('../private.txt', asset.assetId);
    assert.throws(() => store.readAsset(asset.assetId), { code: 'ASSET_PATH_REJECTED' });
});
test('symlinked managed file cannot disclose a file outside the managed root', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const asset = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    const file = store.resolveAssetPath(asset.assetId);
    const external = path.join(f.directory, 'external.txt');
    fs.writeFileSync(external, 'private external');
    fs.unlinkSync(file);
    try {
        fs.symlinkSync(external, file, 'file');
    }
    catch (error) {
        if (error.code === 'EPERM') {
            t.skip('Windows process lacks symlink privilege');
            return;
        }
        throw error;
    }
    assert.throws(() => store.readAsset(asset.assetId), { code: 'ASSET_PATH_REJECTED' });
    assert.equal(fs.readFileSync(external, 'utf8'), 'private external');
    fs.unlinkSync(file);
});
test('drafts are independent per mode, preserve Chinese/newlines and swap/remove only references', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const a = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    const b = store.importBuffer(fixture('reference-b.png'), { mimeType: 'image/png' });
    const modes = ['image.text', 'image.reference', 'video.text', 'video.single_reference', 'video.dual_reference'];
    for (const [index, mode] of modes.entries())
        store.putDraft(mode, { prompt: '中文\n"对白"\r\n' + index, model: 'model-' + index, parameters: { duration: 6, aspectRatio: '16:9' }, inputAssets: refs([a, b]), expectedRevision: 0 });
    store.putDraft('video.dual_reference', { prompt: 'reordered', model: 'fixture', parameters: {}, inputAssets: refs([b, a]), expectedRevision: 1 });
    store.putDraft('video.single_reference', { prompt: 'removed', model: 'fixture', parameters: {}, inputAssets: [], expectedRevision: 1 });
    assert.equal(store.getDraft('image.text').prompt, '中文\n"对白"\r\n0');
    assert.deepEqual(store.getDraft('video.dual_reference').inputAssets.map(asset => asset.assetId), [b.assetId, a.assetId]);
    assert.ok(fs.existsSync(store.resolveAssetPath(a.assetId)));
});
test('stale draft revisions and invalid asset lists roll back without partial writes', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const asset = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    const dto = { prompt: 'original', model: 'fixture', parameters: {}, inputAssets: refs([asset]), expectedRevision: 0 };
    store.putDraft('image.reference', dto);
    assert.throws(() => store.putDraft('image.reference', { ...dto, prompt: 'stale' }), { code: 'DRAFT_REVISION_CONFLICT' });
    assert.equal(store.getDraft('image.reference').prompt, 'original');
    assert.throws(() => f.db.transaction(() => { store.putDraft('image.reference', { ...dto, prompt: 'rolled back', expectedRevision: 1 }); throw new Error('injected'); })(), /injected/);
    assert.equal(store.getDraft('image.reference').prompt, 'original');
    assert.equal(store.countReferences(asset.assetId), 1);
});
test('task snapshot and connection versions remain immutable when draft/current connection changes', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const connection = randomUUID(), v1 = randomUUID(), v2 = randomUUID();
    const now = new Date().toISOString();
    f.db.prepare('INSERT INTO connections VALUES(?,?,?,?,?)').run(connection, 'fixture', null, now, now);
    const insert = f.db.prepare('INSERT INTO connection_versions VALUES(?,?,?,?,?,?)');
    insert.run(v1, connection, 'https://example.invalid', 'fixture', null, now);
    insert.run(v2, connection, 'https://other.invalid', 'fixture', null, now);
    f.db.prepare('UPDATE connections SET current_version_id=? WHERE id=?').run(v1, connection);
    const asset = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    const id = task(f.db);
    const snapshot = { contractVersion: 1, mode: 'image.reference', connectionVersionId: v1, prompt: 'original\n"台词"', model: 'fixture', parameters: { quality: 'high' }, inputAssets: refs([asset]) };
    store.setTaskSnapshot(id, snapshot);
    f.db.prepare('UPDATE connections SET current_version_id=? WHERE id=?').run(v2, connection);
    store.putDraft('image.reference', { prompt: 'new', model: 'new', parameters: { quality: 'low' }, inputAssets: [] });
    assert.equal(f.db.prepare('SELECT connection_version_id FROM tasks WHERE id=?').get(id).connection_version_id, v1);
    assert.deepEqual(JSON.parse(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id).input_snapshot_json), snapshot);
    assert.throws(() => store.setTaskSnapshot(id, { ...snapshot, prompt: 'changed' }), { code: 'IMMUTABLE_TASK_SNAPSHOT' });
    assert.throws(() => store.bindTaskAssets(id, []), { code: 'IMMUTABLE_TASK_INPUTS' });
    assert.throws(() => f.db.prepare('UPDATE connection_versions SET base_url=? WHERE id=?').run('https://changed.invalid', v1), /IMMUTABLE_CONNECTION_VERSION/);
    assert.throws(() => f.db.prepare('UPDATE tasks SET input_snapshot_json=? WHERE id=?').run('{}', id), /IMMUTABLE_TASK_SNAPSHOT/);
});
test('failed/deleted task never deletes a shared input or another draft/task reference', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const asset = store.importBuffer(fixture('reference-a.png'), { mimeType: 'image/png' });
    const a = task(f.db), b = task(f.db);
    store.bindTaskAssets(a, refs([asset]));
    store.bindTaskAssets(b, refs([asset]));
    store.putDraft('image.reference', { prompt: 'shared', model: 'fixture', parameters: {}, inputAssets: refs([asset]) });
    f.db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(a);
    store.deleteTaskHistory(a);
    assert.equal(store.countReferences(asset.assetId), 2);
    assert.deepEqual(store.readAsset(asset.assetId).bytes, fixture('reference-a.png'));
    assert.ok(store.getTask(b));
    assert.throws(() => f.db.prepare('DELETE FROM assets WHERE id=?').run(asset.assetId), /FOREIGN KEY/);
});
test('settings and events are durable, ordered, revisioned, and reject credential/path fields', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const id = task(f.db);
    store.appendTaskEvent(id, 'storage_verified', { assetCount: 2 });
    store.appendTaskEvent(id, 'acknowledged');
    assert.deepEqual(store.events(id).map(event => event.type), ['legacy_task_created', 'storage_verified', 'acknowledged']);
    store.putSetting('theme', { value: 'dark', expectedRevision: 0 });
    assert.equal(store.getSetting('theme').value, 'dark');
    assert.throws(() => store.putSetting('theme', { value: 'light', expectedRevision: 0 }), { code: 'SETTING_REVISION_CONFLICT' });
    assert.throws(() => store.putDraft('image.text', { prompt: 'x', model: 'fixture', parameters: { apiKey: 'synthetic-secret' }, inputAssets: [] }), { code: 'SENSITIVE_STORAGE_FIELD' });
    assert.throws(() => store.appendTaskEvent(id, 'bad', { authorization: 'synthetic' }), { code: 'SENSITIVE_STORAGE_FIELD' });
    assert.throws(() => store.putSetting('outputPath', { value: 'C:\\private' }), { code: 'INVALID_SETTING_KEY' });
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM app_settings').all()).includes('synthetic-secret'), false);
});
test('history pagination preserves more than fifty records and does not include raw request secrets/paths', async (t) => {
    const f = await setup(t);
    const store = f.store();
    for (let index = 0; index < 61; index++)
        task(f.db, randomUUID(), 'completed', 'task-' + index);
    const first = store.listTasks({ limit: 50 });
    const last = store.listTasks({ limit: 50, offset: 50 });
    assert.equal(first.total, 61);
    assert.equal(last.items.length, 11);
    assert.equal(new Set([...first.items, ...last.items].map(row => row.localTaskId)).size, 61);
    assert.equal(JSON.stringify(first).includes('request_json'), false);
});
test('desktop plugin media retention protects shared files during failure/TTL cleanup; Web policy remains explicit', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const directory = path.join(f.directory, 'plugin-media');
    fs.mkdirSync(directory);
    const fileName = randomUUID() + '.png';
    const file = path.join(directory, fileName);
    fs.writeFileSync(file, fixture('reference-a.png'));
    const asset = store.registerLegacyFile('plugin-media', fileName, file, 'image/png');
    const a = task(f.db), b = task(f.db);
    const previous = process.env.NOVA_PLUGIN_MEDIA_DIR;
    process.env.NOVA_PLUGIN_MEDIA_DIR = directory;
    const deps = { db: f.db, getRuntimeEnv: () => ({}), parseIntegerEnv: (_value, fallback) => fallback, createHttpError: () => new Error('test'), getClientIp: () => '', normalizeBaseUrl: value => value };
    const media = createMediaStore({ ...deps, retainHistory: true, getAssetService: () => store });
    if (previous === undefined)
        delete process.env.NOVA_PLUGIN_MEDIA_DIR;
    else
        process.env.NOVA_PLUGIN_MEDIA_DIR = previous;
    const url = 'http://127.0.0.1:1234/api/nova/plugin-media/' + fileName;
    media.bindToTask(a, [url, url]);
    media.bindToTask(b, [url]);
    assert.equal(store.taskAssets(a).length, 2);
    fs.utimesSync(file, new Date(0), new Date(0));
    assert.equal(media.deleteTaskMedia(a).retained, true);
    media.cleanupExpired();
    assert.ok(fs.existsSync(file));
    assert.equal(store.countReferences(asset.assetId), 3);
});
test('backup failure prevents every schema/data update and preserves the blocked destination', async (t) => {
    const f = await setup(t, { legacy: true });
    const id = task(f.db);
    const blocked = path.join(f.directory, 'backup-blocked');
    fs.writeFileSync(blocked, 'existing unknown file');
    await assert.rejects(migrateDatabase({ db: f.db, dbPath: f.dbPath, backupDirectory: blocked }), { code: 'STORAGE_BACKUP_FAILED' });
    assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'completed');
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    assert.equal(fs.readFileSync(blocked, 'utf8'), 'existing unknown file');
});
test('unrelated existing SQLite file is rejected before schema or backup writes', async (t) => {
    const f = await setup(t, { legacy: true });
    f.db.exec('DROP TABLE task_items; DROP TABLE tasks; DROP TABLE plugin_media; CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'preserve\');');
    await assert.rejects(f.upgrade(), { code: 'MIGRATION_SOURCE_UNRECOGNIZED' });
    assert.equal(f.db.prepare('SELECT value FROM unrelated').get().value, 'preserve');
    assert.equal(fs.existsSync(path.join(f.directory, 'backups')), false);
});
test('batch file selection is transactional for metadata and never removes either selected source', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const good = path.join(f.directory, 'good.png'), bad = path.join(f.directory, 'unsupported.txt');
    fs.writeFileSync(good, fixture('reference-a.png'));
    fs.writeFileSync(bad, 'unknown');
    assert.throws(() => store.importFiles([good, bad]), { code: 'ASSET_TYPE_INVALID' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM assets').get().n, 0);
    assert.ok(fs.existsSync(good) && fs.existsSync(bad));
});
test('current generated output route is backed by an asset ID and survives removing its compatibility file', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const id = task(f.db);
    const fileName = id + '-0-0.png';
    const file = path.join(f.directory, fileName);
    fs.writeFileSync(file, fixture('reference-a.png'));
    const asset = store.registerLegacyFile('image', fileName, file, 'image/png');
    assert.equal(store.taskAssets(id, 'output')[0].assetId, asset.assetId);
    assert.equal(asset.validationState, 'unverified');
    fs.unlinkSync(file);
    assert.equal(store.legacyImage(id, 0).assetId, asset.assetId);
    assert.deepEqual(store.readAsset(asset.assetId).bytes, fixture('reference-a.png'));
});
test('import IPC accepts no renderer paths, rejects untrusted senders before dialog, and returns opaque assets', async (t) => {
    const f = await setup(t);
    const store = f.store();
    const selected = path.join(f.directory, 'native.png');
    fs.writeFileSync(selected, fixture('reference-a.png'));
    const handlers = new Map();
    let dialogs = 0;
    const { registerDesktopIpc } = require('../../desktop/ipc.cjs');
    const ipc = registerDesktopIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }, dialog: { showOpenDialog: async () => { dialogs++; return { canceled: false, filePaths: [selected] }; } }, getWindow: () => ({}), policy: { isTrustedSender: event => event.trusted }, runtimeInfo: () => ({}), getAssetService: () => store });
    t.after(() => ipc.dispose());
    const handler = handlers.get('nova:import-reference-assets');
    assert.equal((await handler({ trusted: false })).code, 'IPC_FORBIDDEN');
    assert.equal(dialogs, 0);
    assert.equal((await handler({ trusted: true }, 'C:\\arbitrary')).code, 'INVALID_ARGUMENT');
    assert.equal(dialogs, 0);
    const result = await handler({ trusted: true });
    assert.equal(result.ok, true);
    assert.equal(result.assets.length, 1);
    assert.equal(JSON.stringify(result).includes(selected), false);
    assert.equal(dialogs, 1);
});
