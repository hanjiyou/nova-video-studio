'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1/reference-a.png'));
const refs = asset => [{ assetId: asset.assetId, role: 'reference', position: 0 }];

async function fixture(t, defaultRoot = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-b4-physical-alias-'));
    const dbPath = path.join(directory, 'tasks.sqlite'), db = new Database(dbPath);
    await migrateDatabase({ db, dbPath });
    const storage = path.join(directory, 'storage');
    let store = createWorkbenchStore({ db, rootDirectory: storage });
    const output = defaultRoot ? storage : path.join(directory, '同一 输出目录');
    fs.mkdirSync(output, { recursive: true });
    const importAt = rootRef => store.importBuffer(png, { mimeType: 'image/png', sourceKind: 'generated', rootRef, validation: { width: 2, height: 2 } });
    const firstRoot = defaultRoot ? null : store.selectOutputDirectory(output).outputRootRef;
    const a = importAt(firstRoot);
    const secondRoot = store.selectOutputDirectory(output).outputRootRef;
    const b = importAt(secondRoot);
    assert.notEqual(firstRoot, secondRoot);
    assert.notEqual(a.assetId, b.assetId, 'Existing distinct asset identities must remain in the regression');
    assert.equal(store.resolveAssetPath(a.assetId), store.resolveAssetPath(b.assetId));
    // Reopen the service over existing aliases rather than relying on a new-import deduplication fix.
    store = createWorkbenchStore({ db, rootDirectory: storage });
    function task(input, status = 'completed') {
        const id = randomUUID();
        db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(id, status, 'image.text', '{}', new Date().toISOString());
        store.setTaskSnapshot(id, { contractVersion: 1, localRequestId: randomUUID(), mode: input ? 'image.reference' : 'image.text', model: 'synthetic-alias-fixture', prompt: '物理别名回归', parameters: {}, inputAssets: input ? refs(input) : [] });
        return id;
    }
    const owner = task(); store.bindTaskAssets(owner, refs(a), 'output');
    t.after(() => { db.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
    return { directory, db, store, a, b, owner, task };
}

for (const defaultRoot of [false, true]) {
    for (const reference of ['task-output', 'task-input', 'draft', 'download-candidate', 'submission-intent', 'legacy-link']) {
        test(`B4 ${defaultRoot ? 'default plus explicit same directory' : 'same directory reselected'} preserves physical alias held by ${reference}`, async t => {
            const f = await fixture(t, defaultRoot);
            let other;
            if (reference === 'task-output') { other = f.task(); f.store.bindTaskAssets(other, refs(f.b), 'output'); }
            if (reference === 'task-input') other = f.task(f.b);
            if (reference === 'draft') f.store.putDraft('video.single_reference', { prompt: '保留', model: '', parameters: {}, inputAssets: refs(f.b) });
            if (reference === 'download-candidate') { other = f.task(null, 'remote_completed'); f.db.prepare('UPDATE tasks SET result_sources_json=? WHERE id=?').run(JSON.stringify([{ kind: 'inline', assetId: f.b.assetId }]), other); }
            if (reference === 'submission-intent') f.db.prepare('INSERT INTO workbench_submission_intents(local_request_id,input_json,created_at) VALUES(?,?,?)').run(randomUUID(), JSON.stringify({ inputAssets: refs(f.b) }), new Date().toISOString());
            if (reference === 'legacy-link') f.store.linkLegacyAsset('image', 'physical-alias.png', f.b.assetId);
            const result = f.store.removeHistory(f.owner, { deleteOutputs: true });
            assert.equal(result.deletedAssets, 0);
            assert.equal(result.retainedAssets, 1);
            assert.deepEqual(result.fileErrors, []);
            assert.deepEqual(f.store.readAsset(f.a.assetId).bytes, png);
            assert.deepEqual(f.store.readAsset(f.b.assetId).bytes, png);
            assert.equal(f.store.getAsset(f.b.assetId).availability, 'available');
            if (other && reference === 'task-output') assert.equal(f.store.getTask(other).outputAssets[0].availability, 'available');
        });
    }
}

test('B4 an alias used as the removed task input also protects the physical file', async t => {
    const f = await fixture(t);
    const owner = f.task(f.b); f.store.bindTaskAssets(owner, refs(f.a), 'output');
    // Isolate the same-task input from the fixture's other output reference.
    f.db.prepare('DELETE FROM task_assets WHERE task_id=?').run(f.owner);
    assert.equal(f.store.removeHistory(owner, { deleteOutputs: true }).deletedAssets, 0);
    assert.deepEqual(f.store.readAsset(f.b.assetId).bytes, png);
});

test('B4 unreferenced aliases of an exclusive generated file can be cleaned once', async t => {
    const f = await fixture(t);
    f.store.bindTaskAssets(f.owner, [refs(f.a)[0], { ...refs(f.b)[0], position: 1 }], 'output');
    const file = f.store.resolveAssetPath(f.a.assetId);
    const result = f.store.removeHistory(f.owner, { deleteOutputs: true });
    assert.equal(result.deletedAssets, 1);
    assert.equal(result.retainedAssets, 0);
    assert.equal(fs.existsSync(file), false);
    assert.equal(f.store.getAsset(f.a.assetId).availability, 'missing');
    assert.equal(f.store.getAsset(f.b.assetId).availability, 'missing');
});

test('B4 identical bytes in a different physical directory do not block exclusive cleanup', async t => {
    const f = await fixture(t);
    const otherDirectory = path.join(f.directory, '独立 输出目录'); fs.mkdirSync(otherDirectory);
    const otherRoot = f.store.selectOutputDirectory(otherDirectory).outputRootRef;
    const otherAsset = f.store.importBuffer(png, { mimeType: 'image/png', sourceKind: 'generated', rootRef: otherRoot, validation: { width: 2, height: 2 } });
    assert.notEqual(f.store.resolveAssetPath(f.a.assetId), f.store.resolveAssetPath(otherAsset.assetId));
    const other = f.task(); f.store.bindTaskAssets(other, refs(otherAsset), 'output');
    assert.equal(f.store.removeHistory(f.owner, { deleteOutputs: true }).deletedAssets, 1);
    assert.deepEqual(f.store.readAsset(otherAsset.assetId).bytes, png);
    assert.equal(f.store.getTask(other).outputAssets[0].availability, 'available');
});
