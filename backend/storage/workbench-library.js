'use strict';
const fs = require('node:fs');
const { fail, UUID } = require('./store');
const { canonical } = require('../tasks/service');
// The renderer never supplies a filesystem path. Hidden records keep durable POST deduplication.
function createWorkbenchLibrary({ db, getTask, readAsset, trustedPath, row, freeze }) {
    const id = value => { if (!UUID.test(value || '')) throw fail('INVALID_ID'); return value; };
    function prepareSubmission(input, auth, store) {
        const boundary = require('../tasks/workbench-input');
        const snapshot = freeze(boundary.snapshotFor(input, require('../plugins/opensosen-video/manifest.json').version));
        boundary.validateInputs(snapshot, auth, store);
        boundary.validateCapability(db, snapshot, auth);
        const frozen = Object.fromEntries(['localRequestId','connectionVersionId','capabilityVersionId','mode','model','prompt','parameters','inputAssets','outputDirectoryVersionId','outputRootRef','groupId','groupName','groupDirectoryVersionId'].filter(key => snapshot[key] !== undefined).map(key => [key,snapshot[key]]));
        const prior = db.prepare('SELECT input_json FROM workbench_submission_intents WHERE local_request_id=?').get(input.localRequestId);
        if (prior && canonical(JSON.parse(prior.input_json)) !== canonical(frozen)) throw fail('LOCAL_REQUEST_CONFLICT', '该本地提交意图已存在，不能更改。', 409);
        db.prepare('INSERT OR IGNORE INTO workbench_submission_intents(local_request_id,input_json,created_at) VALUES(?,?,?)').run(input.localRequestId, canonical(frozen), new Date().toISOString());
        return frozen;
    }
    function submissions() {
        return db.prepare('SELECT i.*,t.id AS task_id FROM workbench_submission_intents i LEFT JOIN tasks t ON t.local_request_id=i.local_request_id ORDER BY i.created_at').all().map(item => ({ localRequestId: item.local_request_id, input: JSON.parse(item.input_json), createdAt: item.created_at, attemptStartedAt: item.attempt_started_at, taskId: item.task_id || null }));
    }
    const fileIdentity = file => process.platform === 'win32' ? file.toLowerCase() : file;
    function managedObjects() {
        // root_ref and assetId are metadata versions, not physical file identities.
        // Resolve every existing managed record: old root aliases, default/explicit roots,
        // separator differences and allowed internal directory aliases must all converge.
        const objects = new Map(), byAsset = new Map();
        for (const asset of db.prepare('SELECT * FROM assets').all()) {
            const file = trustedPath(asset);
            if (!file) continue;
            const key = fileIdentity(file);
            let object = objects.get(key);
            if (!object) { object = { key, file, assets: [] }; objects.set(key, object); }
            object.assets.push(asset); byAsset.set(asset.id, object);
        }
        return byAsset;
    }
    function removeHistory(idValue, { deleteOutputs } = {}) {
        id(idValue);
        if (typeof deleteOutputs !== 'boolean') throw fail('INVALID_STORAGE_INPUT');
        const task = getTask(idValue);
        if (!task) throw fail('TASK_NOT_FOUND', '找不到任务。', 404);
        if (task.localExecutionActive || task.downloadAttempt?.active) throw fail('TASK_ACTIVE', '任务仍在本地执行，请先取消，等待取消确认后再移除。', 409);
        let deletedAssets = 0, retainedAssets = 0; const fileErrors = [];
        db.prepare('INSERT OR IGNORE INTO workbench_hidden_tasks VALUES(?,?)').run(idValue, new Date().toISOString());
        if (!deleteOutputs) return { removed: true, deletedAssets, retainedAssets, fileErrors };
        let objects;
        try { objects = managedObjects(); }
        catch { return { removed: true, deletedAssets: 0, retainedAssets: new Set(task.outputAssets.map(asset => asset.assetId)).size, fileErrors: ['FILESYSTEM_ERROR'] }; }
        const handled = new Set();
        for (const assetId of new Set(task.outputAssets.map(asset => asset.assetId))) {
            const asset = row(assetId);
            const object = objects.get(assetId);
            // Already absent files are not counted as a successful physical deletion.
            if (!object) continue;
            if (handled.has(object.key)) continue;
            handled.add(object.key);
            const aliases = new Set(object.assets.map(item => item.id));
            const other = object.assets.some(item => db.prepare("SELECT (SELECT count(*) FROM task_assets WHERE asset_id=? AND (task_id<>? OR role='input')) + (SELECT count(*) FROM draft_assets WHERE asset_id=?) + (SELECT count(*) FROM group_draft_assets WHERE asset_id=?) + (SELECT count(*) FROM task_download_files WHERE asset_id=? AND task_id<>?) AS n").get(item.id,idValue,item.id,item.id,item.id,idValue).n);
            const intentUses = submissions().some(intent => !intent.taskId && intent.input.inputAssets.some(item => aliases.has(item.assetId)));
            const candidateUses = db.prepare('SELECT result_sources_json FROM tasks WHERE id<>? AND result_sources_json IS NOT NULL').all(idValue).some(task => { try { return JSON.parse(task.result_sources_json).some(source => aliases.has(source.assetId)); } catch { return true; } });
            const legacyUses = object.assets.some(item => db.prepare('SELECT 1 FROM asset_legacy_links WHERE asset_id=? LIMIT 1').get(item.id));
            if (object.assets.some(item => item.source_kind !== 'generated') || other || intentUses || candidateUses || legacyUses) { retainedAssets++; continue; }
            try {
                readAsset(assetId);
                const file = trustedPath(asset);
                if (!file || fileIdentity(file) !== object.key) throw fail('ASSET_PATH_REJECTED');
                fs.unlinkSync(file);
                for (const alias of object.assets) db.prepare("UPDATE assets SET availability='missing' WHERE id=?").run(alias.id);
                deletedAssets++;
            }
            catch { retainedAssets++; fileErrors.push('FILESYSTEM_ERROR'); }
        }
        return { removed: true, deletedAssets, retainedAssets, fileErrors };
    }
    function removeTaskDisplay(idValue) {
        id(idValue);
        const task = getTask(idValue);
        if (!task) throw fail('TASK_NOT_FOUND', '找不到任务。', 404);
        if (task.localExecutionActive || task.downloadAttempt?.active) throw fail('TASK_ACTIVE', '任务仍在本地执行，请先取消，等待取消确认后再移除。', 409);
        db.prepare('INSERT OR IGNORE INTO workbench_removed_tasks(task_id,removed_at) VALUES(?,?)').run(idValue, new Date().toISOString());
        return { removed: true, worksRetained: true };
    }
    return { prepareSubmission, submissions, removeTaskDisplay: idValue => db.transaction(() => removeTaskDisplay(idValue)).immediate(),
        validateSubmissionInput: input => { if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INPUT_INVALID'); const saved = db.prepare('SELECT input_json FROM workbench_submission_intents WHERE local_request_id=?').get(input.localRequestId); if (saved && canonical(JSON.parse(saved.input_json)) !== canonical(input)) throw fail('LOCAL_REQUEST_CONFLICT', '创建输入与已保存的本地意图不同。', 409); },
        markSubmissionAttempt: requestId => { id(requestId); const result = db.prepare('UPDATE workbench_submission_intents SET attempt_started_at=? WHERE local_request_id=? AND attempt_started_at IS NULL').run(new Date().toISOString(), requestId); if (!result.changes) throw fail('SUBMISSION_ALREADY_ATTEMPTED', '该意图已尝试提交，请只核对本地记录。', 409); return { marked: true }; },
        dismissSubmission: requestId => { id(requestId); db.prepare('DELETE FROM workbench_submission_intents WHERE local_request_id=?').run(requestId); return { dismissed: true }; }, removeHistory: (...args) => db.transaction(() => removeHistory(...args)).immediate() };
}
module.exports = { createWorkbenchLibrary };
