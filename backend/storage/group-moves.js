'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DEFAULT_GROUP, LIMITS, validName, bounded } = require('./groups');
const { localOutcome } = require('../tasks/lifecycle-contract');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
const keyName = value => value.normalize('NFC').toLowerCase();
const now = () => new Date().toISOString();
function input(value, keys) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) throw error('INVALID_STORAGE_INPUT', '整理请求无效。', 400);
}
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw error('INVALID_ID', '整理请求编号无效。', 400); return value.toLowerCase(); }
function createGroupMoves({ db, groups, outputDirectories, trustedPath, isTaskExecutionActive = () => false, fault = () => {} }) {
    const operation = requestId => db.prepare('SELECT * FROM group_file_operations WHERE request_id=?').get(requestId);
    const setState = (operationId, state, extra = {}) => db.prepare('UPDATE group_file_operations SET state=?,error_code=?,result_json=COALESCE(?,result_json),updated_at=? WHERE id=?').run(state, extra.code || null, extra.result ? JSON.stringify(extra.result) : null, now(), operationId);
    function task(taskId) {
        const value = db.prepare('SELECT * FROM tasks WHERE id=?').get(id(taskId));
        if (!value) throw error('TASK_NOT_FOUND', '找不到需要整理的任务。', 404);
        return value;
    }
    function active(value) {
        if (isTaskExecutionActive(value.id) || db.prepare('SELECT 1 FROM task_download_attempts WHERE task_id=? AND outcome IS NULL').get(value.id) || db.prepare("SELECT 1 FROM task_downloads WHERE task_id=? AND state IN ('waiting','running')").get(value.id)) return true;
        return !localOutcome(value);
    }
    function idleTask(value) { if (active(value)) throw error('TASK_ACTIVE', '任务仍在生成、下载或写文件，请结束后再整理。'); }
    function groupIntents(groupId) {
        return db.prepare('SELECT i.input_json FROM workbench_submission_intents i LEFT JOIN tasks t ON t.local_request_id=i.local_request_id WHERE t.id IS NULL').all().some(value => { try { return (JSON.parse(value.input_json).groupId || DEFAULT_GROUP) === groupId; } catch { return true; } });
    }
    function idleGroup(groupId) {
        if (groupIntents(groupId) || db.prepare('SELECT t.* FROM task_group_memberships m JOIN tasks t ON t.id=m.task_id WHERE m.group_id=?').all(groupId).some(active)) throw error('GROUP_ACTIVE', '剧本仍有活动任务或待提交意图，请处理后再管理。');
    }
    function idleRenameReferences(groupId) {
        // Renaming a physical directory also affects uploads/decoders reading it from
        // another group's immutable inputs. Include metadata aliases of the same file.
        const assets = db.prepare('SELECT * FROM assets').all(), roots = new Map(db.prepare('SELECT id,directory FROM storage_roots').all().map(root => [root.id, root.directory]));
        const physical = asset => { const root = roots.get(asset.root_ref || outputDirectories.DEFAULT); return root ? identity(path.resolve(root, 'assets', asset.storage_key)) : null; };
        const paths = new Set(assets.filter(asset => asset.group_id === groupId).map(physical).filter(Boolean));
        const assetIds = new Set(assets.filter(asset => asset.group_id === groupId || paths.has(physical(asset))).map(asset => asset.id.toLowerCase()));
        if (!assetIds.size) return;
        const mentions = value => { const lower = String(value || '').toLowerCase(); return [...assetIds].some(assetId => lower.includes(assetId)); };
        const references = new Map();
        for (const reference of db.prepare('SELECT task_id,asset_id FROM task_assets UNION ALL SELECT task_id,asset_id FROM task_download_files').all()) if (assetIds.has(reference.asset_id.toLowerCase())) references.set(reference.task_id, true);
        if (db.prepare('SELECT * FROM tasks').all().some(value => active(value) && (references.has(value.id) || mentions(value.input_snapshot_json) || mentions(value.result_sources_json)))) throw error('GROUP_ACTIVE', '其他剧本的活动任务仍在读取此目录中的素材，请结束后再重命名。');
        if (db.prepare('SELECT i.input_json FROM workbench_submission_intents i LEFT JOIN tasks t ON t.local_request_id=i.local_request_id WHERE t.id IS NULL').all().some(value => mentions(value.input_json))) throw error('GROUP_ACTIVE', '其他剧本的待提交意图仍引用此目录中的素材，请处理后再重命名。');
    }
    function available(groupId) {
        const group = groups.get(groupId);
        if (group.archived_at) throw error('GROUP_ARCHIVED', '剧本已归档，请先取消归档。');
        return group;
    }
    function sourcePath(asset) {
        const file = trustedPath(asset);
        if (!file) throw error('ASSET_MISSING', '原作品文件缺失，归属和原记录已保留。');
        verify(file, asset);
        return file;
    }
    function verify(file, asset) {
        if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw error('ASSET_MISSING', '整理所需文件缺失或类型不正确。');
        const bytes = fs.readFileSync(file);
        if (bytes.length !== asset.byte_length || digest(bytes) !== asset.sha256) throw error('ASSET_CORRUPT', '作品文件与校验记录不一致，原文件已保留。');
    }
    function targetPath(entry, create = false, allowMissing = false) {
        const root = outputDirectories.directory(entry.root_ref), parts = entry.storage_key.split(/[\\/]/);
        if (parts.length !== 3 || !['图片','视频'].includes(parts[1])) throw error('ASSET_PATH_REJECTED', '目标受管路径无效。');
        validName(parts[0]);
        if (!parts[2] || parts[2] === '.' || parts[2] === '..' || /[<>:"|?*\p{Cc}]/u.test(parts[2])) throw error('ASSET_PATH_REJECTED', '目标文件名无效。');
        if (!groups.safeDirectory(root, ['assets', ...parts.slice(0, -1)], create) && !allowMissing) throw error('DIRECTORY_NOT_WRITABLE', '目标目录不可用。');
        return bounded(path.join(root, 'assets', ...parts));
    }
    function filename(value, position, asset) {
        const location = db.prepare('SELECT storage_key FROM task_output_locations WHERE task_id=? AND position=?').get(value.id, position);
        if (location) return path.basename(location.storage_key);
        const when = new Date(value.created_at), snapshot = JSON.parse(value.input_snapshot_json || value.request_json || '{}');
        if (!Number.isFinite(when.getTime())) throw error('OUTPUT_DIRECTORY_INVALID', '历史任务创建时间无效，不能确定成品名称。');
        const pad = number => String(number).padStart(2, '0');
        const stamp = String(when.getFullYear()) + pad(when.getMonth() + 1) + pad(when.getDate()) + '-' + pad(when.getHours()) + pad(when.getMinutes()) + pad(when.getSeconds());
        const description = Array.from(String(snapshot.prompt || '').replace(/[<>:"/\\|?*\p{Cc}\uD800-\uDFFF]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/[. ]+$/g, '')).reduce((result, letter) => result.length + letter.length <= LIMITS.description ? result + letter : result, '') || (asset.kind === 'image' ? '图片' : '视频');
        return stamp + '_' + description + '_' + digest(Buffer.from(value.id + ':' + position)).slice(0, 12) + (position ? '_' + (position + 1) : '') + path.extname(asset.storage_key);
    }
    function newPlan(value, groupId, organize = false, preview = false) {
        idleTask(value); const group = available(groupId), member = groups.membership(value.id);
        const outputs = db.prepare("SELECT a.*,ta.position,1 AS formal FROM task_assets ta JOIN assets a ON a.id=ta.asset_id WHERE ta.task_id=? AND ta.role='output' ORDER BY ta.position").all(value.id);
        const checkpoints = db.prepare('SELECT a.*,f.position,f.source_key,0 AS formal FROM task_download_files f JOIN assets a ON a.id=f.asset_id WHERE f.task_id=? ORDER BY f.position').all(value.id);
        const rootRef = member?.root_ref || value.output_root_ref || outputs[0]?.root_ref || outputDirectories.DEFAULT;
        let version = db.prepare('SELECT v.* FROM group_directory_current c JOIN group_directory_versions v ON v.id=c.version_id WHERE c.group_id=? AND c.root_ref=?').get(group.id, rootRef);
        if (!preview) version = groups.ensure(group.id, rootRef);
        else if (!version) {
            const root = outputDirectories.directory(rootRef), assets = groups.safeDirectory(root, ['assets']);
            const alias = db.prepare('SELECT v.* FROM group_directory_current c JOIN group_directory_versions v ON v.id=c.version_id JOIN storage_roots r ON r.id=c.root_ref WHERE c.group_id=? AND r.directory=? LIMIT 1').get(group.id, root);
            if (!alias && assets && fs.readdirSync(assets).some(name => keyName(name) === keyName(group.name))) throw error('GROUP_DIRECTORY_CONFLICT', '目标同名目录尚未受管，请处理冲突。');
            version = alias || { id: null, group_id: group.id, root_ref: rootRef, directory_name: group.name };
        }
        const bySlot = new Map(outputs.map(asset => [asset.position, asset]));
        for (const asset of checkpoints) if (!bySlot.has(asset.position)) {
            // Missing partial checkpoints will be downloaded again at the newly reserved location.
            if (asset.validation_state === 'verified' && asset.availability === 'available' && trustedPath(asset)) bySlot.set(asset.position, asset);
        }
        const files = [];
        for (const asset of bySlot.values()) {
            if (asset.validation_state !== 'verified' || asset.availability !== 'available') throw error('ASSET_CORRUPT', '作品尚未完整校验，不能迁移。');
            const source = sourcePath(asset), media = asset.kind === 'image' ? '图片' : '视频';
            const entry = { ...asset, source_asset_id: asset.id, target_asset_id: randomUUID(), source_root_ref: asset.root_ref, source_storage_key: asset.storage_key, source_group_id: asset.group_id, root_ref: rootRef, storage_key: path.join(version.directory_name, media, filename(value, asset.position, asset)), group_id: group.id, directory_version_id: version.id };
            const destination = targetPath(entry, false, preview);
            if (identity(source) === identity(destination)) { entry.keep = true; entry.target_asset_id = asset.id; }
            else if (fs.existsSync(destination) || db.prepare('SELECT 1 FROM assets WHERE root_ref=? AND storage_key=? UNION ALL SELECT 1 FROM task_output_locations WHERE root_ref=? AND storage_key=? AND task_id<>?').get(rootRef, entry.storage_key, rootRef, entry.storage_key, value.id)) throw error('ASSET_FILE_CONFLICT', '目标已有同名文件或受管记录，请处理冲突后再整理。');
            files.push(entry);
        }
        const reservations = db.prepare('SELECT * FROM task_output_locations WHERE task_id=?').all(value.id).filter(location => !bySlot.has(location.position)).map(location => ({ ...location, source_root_ref: location.root_ref, source_storage_key: location.storage_key, root_ref: rootRef, group_id: group.id, directory_version_id: version.id, storage_key: path.join(version.directory_name, ...location.storage_key.split(/[\\/]/).slice(1)) }));
        for (const location of reservations) {
            const destination = targetPath(location, false, preview);
            const source = path.join(outputDirectories.directory(location.source_root_ref), 'assets', location.source_storage_key);
            if (identity(source) !== identity(destination) && (fs.existsSync(destination) || db.prepare('SELECT 1 FROM assets WHERE root_ref=? AND storage_key=? UNION ALL SELECT 1 FROM task_output_locations WHERE root_ref=? AND storage_key=? AND task_id<>?').get(rootRef, location.storage_key, rootRef, location.storage_key, value.id))) throw error('ASSET_FILE_CONFLICT', '目标预留位置有文件冲突。');
        }
        const discard_checkpoints = checkpoints.filter(checkpoint => !files.some(entry => entry.position === checkpoint.position && entry.source_asset_id === checkpoint.id)).map(checkpoint => ({ source_key: checkpoint.source_key, asset_id: checkpoint.id }));
        return { task_id: value.id, group_id: group.id, from_group_id: member?.group_id || DEFAULT_GROUP, directory_version_id: version.id, root_ref: rootRef, membership_revision: member?.revision, files, reservations, discard_checkpoints, organize };
    }
    function persist(requestId, kind, groupId, plan) {
        const operationId = randomUUID(), time = now();
        db.prepare('INSERT INTO group_file_operations(id,request_id,kind,task_id,group_id,state,plan_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(operationId, requestId, kind, plan.task_id || null, groupId, 'preparing', JSON.stringify(plan), time, time);
        return operation(requestId);
    }
    function resultFor(prior, kind, taskId, groupId, signature) {
        if (prior.kind !== kind || prior.task_id !== taskId || prior.group_id !== groupId || signature && JSON.parse(prior.plan_json).name !== signature) throw error('GROUP_REQUEST_CONFLICT', '同一整理请求编号不能用于其他操作。');
        if (['completed','committed'].includes(prior.state)) return JSON.parse(prior.result_json);
        throw error(prior.error_code || 'GROUP_MOVE_INTERRUPTED', prior.state === 'needs-recovery' ? '上次整理尚需恢复，请处理文件占用后重试。' : '该次整理未完成，原归属已保留；请使用新请求重试。');
    }
    function copyFile(entry, operationId) {
        if (entry.keep) return;
        const source = sourcePath({ ...entry, id: entry.source_asset_id, root_ref: entry.source_root_ref, storage_key: entry.source_storage_key, group_id: entry.source_group_id });
        const target = targetPath(entry), temporary = bounded(path.join(path.dirname(target), '.nova-' + operationId + '-' + entry.position + '.part'));
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        verify(temporary, entry); const fd = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        // Keep the private hardlink until the logical commit. It proves exact physical
        // ownership during interruption rollback, even if a user creates a racing target.
        fs.linkSync(temporary, target); verify(targetPath(entry), entry);
    }
    function bindPlan(plan) {
        const value = task(plan.task_id); idleTask(value);
        const member = groups.membership(value.id);
        if (member.revision !== plan.membership_revision) throw error('GROUP_REVISION_CONFLICT', '任务归属已变化，请刷新后重试。');
        for (const entry of plan.files) {
            verify(targetPath(entry), entry);
            if (!entry.keep) db.prepare('INSERT INTO assets(id,kind,storage_key,display_name,mime_type,byte_length,sha256,width,height,duration_seconds,source_kind,validation_state,availability,created_at,root_ref,group_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(entry.target_asset_id, entry.kind, entry.storage_key, path.basename(entry.storage_key), entry.mime_type, entry.byte_length, entry.sha256, entry.width, entry.height, entry.duration_seconds, 'generated', 'verified', 'available', entry.created_at, entry.root_ref, entry.group_id);
            db.prepare("UPDATE task_assets SET asset_id=? WHERE task_id=? AND role='output' AND position=? AND asset_id=?").run(entry.target_asset_id, value.id, entry.position, entry.source_asset_id);
            db.prepare('UPDATE task_download_files SET asset_id=? WHERE task_id=? AND position=? AND asset_id=?').run(entry.target_asset_id, value.id, entry.position, entry.source_asset_id);
            db.prepare('INSERT INTO task_output_locations VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,position) DO UPDATE SET root_ref=excluded.root_ref,group_id=excluded.group_id,directory_version_id=excluded.directory_version_id,storage_key=excluded.storage_key').run(value.id, entry.position, entry.root_ref, entry.group_id, entry.directory_version_id, entry.storage_key);
        }
        for (const entry of plan.reservations) db.prepare('UPDATE task_output_locations SET root_ref=?,group_id=?,directory_version_id=?,storage_key=? WHERE task_id=? AND position=?').run(entry.root_ref, entry.group_id, entry.directory_version_id, entry.storage_key, value.id, entry.position);
        // A skipped partial checkpoint must never become usable at its old group if its
        // file reappears later. Keep the old asset/file, invalidate only this current resume link.
        for (const checkpoint of plan.discard_checkpoints || []) db.prepare('DELETE FROM task_download_files WHERE task_id=? AND source_key=? AND asset_id=?').run(value.id, checkpoint.source_key, checkpoint.asset_id);
        const sources = JSON.parse(value.result_sources_json || 'null');
        if (Array.isArray(sources)) {
            const replacements = new Map(plan.files.map(entry => [entry.source_asset_id, entry.target_asset_id]));
            let changed = false;
            for (const source of sources) if (source && replacements.has(source.assetId)) { source.assetId = replacements.get(source.assetId); changed = true; }
            if (changed) db.prepare('UPDATE tasks SET result_sources_json=? WHERE id=?').run(JSON.stringify(sources), value.id);
        }
        db.prepare('UPDATE task_group_memberships SET group_id=?,directory_version_id=?,revision=revision+1 WHERE task_id=?').run(plan.group_id, plan.directory_version_id, value.id);
    }
    function hasReferences(assetId) {
        if (db.prepare('SELECT (SELECT count(*) FROM task_assets WHERE asset_id=?) + (SELECT count(*) FROM draft_assets WHERE asset_id=?) + (SELECT count(*) FROM group_draft_assets WHERE asset_id=?) + (SELECT count(*) FROM task_download_files WHERE asset_id=?) + (SELECT count(*) FROM asset_legacy_links WHERE asset_id=?) AS n').get(assetId, assetId, assetId, assetId, assetId).n) return true;
        // Immutable snapshots, pending intents and recovery candidates retain their original IDs.
        for (const value of db.prepare('SELECT input_snapshot_json AS value FROM tasks WHERE input_snapshot_json IS NOT NULL UNION ALL SELECT result_sources_json FROM tasks WHERE result_sources_json IS NOT NULL UNION ALL SELECT input_json FROM workbench_submission_intents').all()) if (String(value.value).toLowerCase().includes(assetId.toLowerCase())) return true;
        return false;
    }
    function releaseSource(entry) {
        if (entry.keep || entry.source_kind !== 'generated') return;
        const old = db.prepare('SELECT * FROM assets WHERE id=?').get(entry.source_asset_id);
        if (!old || hasReferences(old.id)) return;
        const file = trustedPath(old); if (!file) return;
        let aliases;
        try { aliases = db.prepare('SELECT * FROM assets').all().filter(asset => { const other = trustedPath(asset); return other && identity(other) === identity(file); }); }
        catch { return; } // Unavailable alias roots make exclusive ownership unprovable.
        if (aliases.some(asset => asset.source_kind !== 'generated' || hasReferences(asset.id))) return;
        verify(file, old); fs.unlinkSync(file);
        for (const alias of aliases) db.prepare('DELETE FROM assets WHERE id=?').run(alias.id);
    }
    function rollbackMove(op, plan) {
        for (const entry of plan.files) {
            if (entry.keep) continue;
            const target = targetPath(entry), temporary = bounded(path.join(path.dirname(target), '.nova-' + op.id + '-' + entry.position + '.part'));
            // The private temporary name belongs to this operation. A mismatched final target
            // is never removed: it may be a user replacement and requires manual recovery.
            if (fs.existsSync(target)) {
                verify(target, entry);
                if (!fs.existsSync(temporary) || fs.lstatSync(temporary).isSymbolicLink()) throw error('GROUP_RECOVERY_REQUIRED', '无法确认整理目标所有权，原文件已保留。');
                const owner = fs.statSync(temporary), candidate = fs.statSync(target);
                if (owner.dev !== candidate.dev || owner.ino !== candidate.ino) throw error('GROUP_RECOVERY_REQUIRED', '整理目标已被其他文件替换。');
                if (db.prepare('SELECT 1 FROM assets WHERE root_ref=? AND storage_key=?').get(entry.root_ref, entry.storage_key)) throw error('GROUP_RECOVERY_REQUIRED', '整理目标已有新的引用。');
                fs.unlinkSync(target);
            }
            if (fs.existsSync(temporary)) { if (fs.lstatSync(temporary).isSymbolicLink()) throw error('GROUP_RECOVERY_REQUIRED', '整理临时文件发生变化。'); fs.unlinkSync(temporary); }
        }
    }
    function rollbackRename(plan) {
        for (const entry of [...plan.directories].reverse()) {
            const root = outputDirectories.directory(entry.root_ref), old = path.join(root, 'assets', entry.old_name), next = path.join(root, 'assets', plan.name);
            const oldExists = fs.existsSync(old), nextExists = fs.existsSync(next);
            if (oldExists && nextExists || !oldExists && !nextExists) throw error('GROUP_RECOVERY_REQUIRED', '重命名目录状态不明，请恢复原目录或解除占用后重试。');
            if (nextExists) { checkDirectory(root, plan.name, entry); fs.renameSync(next, old); }
            checkDirectory(root, entry.old_name, entry);
        }
    }
    function checkDirectory(root, name, entry) {
        const directory = groups.safeDirectory(root, ['assets', name]);
        if (!directory) throw error('GROUP_RECOVERY_REQUIRED', '重命名目录缺失。');
        const stat = fs.statSync(directory, { bigint: true });
        if (String(stat.dev) !== entry.dev || String(stat.ino) !== entry.ino) throw error('GROUP_RECOVERY_REQUIRED', '重命名目录已被替换，原记录和现有文件均已保留。');
        return directory;
    }
    function recoveryStatus() {
        const unresolved = db.prepare("SELECT * FROM group_file_operations WHERE state='needs-recovery'").all().map(op => {
            const plan = JSON.parse(op.plan_json);
            return { operationId: op.id, taskId: op.task_id, groupIds: [...new Set([op.group_id, plan.group_id, plan.from_group_id].filter(Boolean))], code: op.error_code || 'GROUP_RECOVERY_REQUIRED' };
        });
        return { unresolved };
    }
    function recover(scope) {
        for (const op of db.prepare("SELECT * FROM group_file_operations WHERE state IN ('preparing','committed','needs-recovery') ORDER BY created_at,id").all()) {
            const plan = JSON.parse(op.plan_json);
            try {
                const committed = op.state === 'committed' || op.result_json;
                if (committed) {
                    if (op.kind === 'rename') for (const entry of plan.directories) checkDirectory(outputDirectories.directory(entry.root_ref), plan.name, entry);
                    if (op.kind !== 'rename') for (const entry of plan.files || []) {
                        if (!entry.keep) {
                            const target = targetPath(entry), temporary = bounded(path.join(path.dirname(target), '.nova-' + op.id + '-' + entry.position + '.part'));
                            verify(target, entry);
                            if (fs.existsSync(temporary)) { verify(temporary, entry); fs.unlinkSync(temporary); }
                        }
                        releaseSource(entry);
                    }
                    setState(op.id, 'completed');
                } else {
                    if (op.kind === 'rename') rollbackRename(plan); else rollbackMove(op, plan);
                    setState(op.id, 'failed', { code: op.error_code || 'GROUP_MOVE_INTERRUPTED' });
                }
            } catch (cause) { setState(op.id, 'needs-recovery', { code: cause.code || 'GROUP_RECOVERY_REQUIRED' }); }
        }
        const { unresolved } = recoveryStatus();
        const selectedGroups = new Set([scope?.groupId, ...(scope?.groupIds || [])].filter(Boolean));
        if (scope && unresolved.some(op => scope.taskId && op.taskId === scope.taskId || op.groupIds.some(groupId => selectedGroups.has(groupId)))) throw error('GROUP_RECOVERY_REQUIRED', '此剧本上次文件整理尚未恢复，请解除文件占用或恢复受管目录后再试。');
        return { unresolved };
    }
    function moveTask(taskId, value, organize = false) {
        input(value, ['groupId','requestId','expectedRevision']); value = { ...value, groupId: id(value.groupId) }; const requestId = id(value.requestId); taskId = id(taskId);
        const scope = { taskId, groupIds: [value.groupId, groups.membership(taskId)?.group_id] }; recover(scope);
        const kind = organize ? 'organize' : 'move', prior = operation(requestId); if (prior) return resultFor(prior, kind, taskId, value.groupId);
        const current = task(taskId), member = groups.membership(taskId); idleTask(current); available(value.groupId);
        if (value.expectedRevision !== undefined && value.expectedRevision !== member.revision) throw error('GROUP_REVISION_CONFLICT', '任务归属已变化，请刷新后重试。');
        if (!organize && member.group_id === value.groupId) return { taskId, groupId: value.groupId, movedFiles: 0, unchanged: true };
        const plan = newPlan(current, value.groupId, organize);
        const op = persist(requestId, kind, value.groupId, plan);
        try {
            fault('prepared', op); for (const entry of plan.files) { copyFile(entry, op.id); fault('copied', op, entry); }
            const result = { operationId: op.id, taskId, groupId: value.groupId, movedFiles: plan.files.filter(entry => !entry.keep).length };
            db.transaction(() => { bindPlan(plan); fault('before-commit', op); setState(op.id, 'committed', { result }); })();
            fault('committed', op); recover(scope); return result;
        } catch (cause) {
            if (cause.simulateCrash) throw cause;
            const saved = operation(requestId); if (saved.state !== 'committed') setState(op.id, 'preparing', { code: cause.code || 'GROUP_MOVE_FAILED' });
            try { recover(scope); } catch { throw error('GROUP_RECOVERY_REQUIRED', '整理未能安全收尾，请解除文件占用后重试。'); }
            if (saved.state === 'committed') return JSON.parse(saved.result_json);
            throw cause;
        }
    }
    function renameGroup(groupId, value) {
        input(value, ['name','requestId']); groupId = id(groupId); const requestId = id(value.requestId), name = validName(value.name); recover({ groupId });
        const prior = operation(requestId); if (prior) return resultFor(prior, 'rename', null, groupId, name);
        const group = groups.get(groupId); if (group.is_default) throw error('GROUP_DEFAULT_IMMUTABLE', '未分组不能重命名。'); idleGroup(groupId); idleRenameReferences(groupId);
        if (name === group.name) return { groupId, name, renamedRoots: 0 };
        if (db.prepare('SELECT 1 FROM workbench_groups WHERE name_key=? AND id<>?').get(keyName(name), groupId)) throw error('GROUP_NAME_CONFLICT', '已存在同名剧本。');
        const versions = db.prepare('SELECT v.* FROM group_directory_current c JOIN group_directory_versions v ON v.id=c.version_id WHERE c.group_id=?').all(groupId), seen = new Set(), directories = [];
        for (const version of versions) {
            const root = outputDirectories.directory(version.root_ref), physical = identity(root); if (seen.has(physical)) continue; seen.add(physical);
            const existing = groups.safeDirectory(root, ['assets', version.directory_name]);
            if (!existing) throw error('ASSET_MISSING', '需要重命名的受管剧本目录缺失。');
            bounded(path.join(root, 'assets', name, '图片', 'x'.repeat(LIMITS.filename))); bounded(path.join(root, 'assets', name, '视频', 'x'.repeat(LIMITS.filename)));
            // Case-only renames need a separate staging name on Windows; reject instead of
            // pretending success or relying on platform-specific rename behavior.
            if (fs.readdirSync(path.join(root, 'assets')).some(entry => keyName(entry) === keyName(name))) throw error('GROUP_DIRECTORY_CONFLICT', '目标目录已存在（包括仅大小写不同），请使用其他名称。');
            const stat = fs.statSync(existing, { bigint: true });
            directories.push({ root_ref: version.root_ref, old_name: version.directory_name, dev: String(stat.dev), ino: String(stat.ino) });
        }
        const plan = { group_id: groupId, name, versions, directories }, op = persist(requestId, 'rename', groupId, plan);
        try {
            fault('prepared', op);
            for (const entry of directories) { const root = outputDirectories.directory(entry.root_ref); checkDirectory(root, entry.old_name, entry); fs.renameSync(path.join(root, 'assets', entry.old_name), path.join(root, 'assets', name)); fault('renamed', op, entry); }
            const result = { operationId: op.id, groupId, name, renamedRoots: directories.length };
            db.transaction(() => {
                idleGroup(groupId);
                idleRenameReferences(groupId);
                for (const entry of directories) checkDirectory(outputDirectories.directory(entry.root_ref), name, entry);
                for (const version of versions) {
                    const next = randomUUID(); db.prepare('INSERT INTO group_directory_versions VALUES(?,?,?,?,?)').run(next, groupId, version.root_ref, name, now());
                    db.prepare('UPDATE group_directory_current SET version_id=? WHERE group_id=? AND root_ref=?').run(next, groupId, version.root_ref);
                    db.prepare('UPDATE task_group_memberships SET directory_version_id=?,revision=revision+1 WHERE group_id=? AND directory_version_id=?').run(next, groupId, version.id);
                    for (const location of db.prepare('SELECT * FROM task_output_locations WHERE group_id=? AND root_ref=?').all(groupId, version.root_ref)) {
                        const parts = location.storage_key.split(/[\\/]/); if (parts[0] !== version.directory_name) throw error('GROUP_RECOVERY_REQUIRED', '作品预留目录与当前剧本目录不一致。');
                        db.prepare('UPDATE task_output_locations SET directory_version_id=?,storage_key=? WHERE task_id=? AND position=?').run(next, path.join(name, ...parts.slice(1)), location.task_id, location.position);
                    }
                    for (const asset of db.prepare('SELECT id,storage_key FROM assets WHERE group_id=? AND root_ref=?').all(groupId, version.root_ref)) {
                        const parts = asset.storage_key.split(/[\\/]/); if (parts[0] !== version.directory_name) throw error('GROUP_RECOVERY_REQUIRED', '作品位置与当前剧本目录不一致。');
                        db.prepare('UPDATE assets SET storage_key=? WHERE id=?').run(path.join(name, ...parts.slice(1)), asset.id);
                    }
                }
                db.prepare('UPDATE workbench_groups SET name=?,name_key=? WHERE id=?').run(name, keyName(name), groupId); setState(op.id, 'committed', { result }); fault('before-commit', op);
            })();
            fault('committed', op); recover({ groupId }); return result;
        } catch (cause) {
            if (cause.simulateCrash) throw cause;
            if (operation(requestId).state !== 'committed') setState(op.id, 'preparing', { code: cause.code || 'GROUP_RENAME_FAILED' });
            try { recover({ groupId }); } catch { throw error('GROUP_RECOVERY_REQUIRED', '目录重命名尚未安全恢复，请解除占用后重试。'); }
            if (operation(requestId).state === 'completed') return JSON.parse(operation(requestId).result_json);
            throw cause;
        }
    }
    function archiveGroup(groupId, value) {
        input(value, ['archived']); groupId = id(groupId); if (typeof value.archived !== 'boolean') throw error('INVALID_STORAGE_INPUT', '归档请求无效。', 400); recover({ groupId });
        const group = groups.get(groupId); if (group.is_default) throw error('GROUP_DEFAULT_IMMUTABLE', '未分组不能归档。'); idleGroup(groupId);
        db.prepare('UPDATE workbench_groups SET archived_at=? WHERE id=?').run(value.archived ? now() : null, groupId);
        return { groupId, archived: value.archived };
    }
    function deleteGroup(groupId) {
        groupId = id(groupId); recover({ groupId }); const group = groups.get(groupId); if (group.is_default) throw error('GROUP_DEFAULT_IMMUTABLE', '未分组不能删除。'); idleGroup(groupId);
        const draftData = db.prepare('SELECT * FROM group_drafts WHERE group_id=?').all(groupId).some(draft => {
            let parameters; try { parameters = JSON.parse(draft.parameters_json); } catch { return true; }
            return draft.prompt.trim() || draft.model.trim() || !parameters || typeof parameters !== 'object' || Object.keys(parameters).length || db.prepare('SELECT 1 FROM group_draft_assets WHERE group_id=? AND mode=?').get(groupId, draft.mode);
        });
        if (db.prepare('SELECT (SELECT count(*) FROM task_group_memberships WHERE group_id=?) + (SELECT count(*) FROM assets WHERE group_id=?) AS n').get(groupId, groupId).n || draftData) throw error('GROUP_NOT_EMPTY', '仅可删除没有任务、作品或草稿内容的空剧本。');
        const directories = [], seen = new Set();
        for (const version of db.prepare('SELECT v.* FROM group_directory_current c JOIN group_directory_versions v ON v.id=c.version_id WHERE c.group_id=?').all(groupId)) {
            const root = outputDirectories.directory(version.root_ref), physical = identity(root); if (seen.has(physical)) continue; seen.add(physical);
            const directory = groups.safeDirectory(root, ['assets', version.directory_name]); if (!directory) continue;
            if (fs.readdirSync(directory).some(name => !['图片','视频'].includes(name))) throw error('GROUP_NOT_EMPTY', '剧本目录包含文件，不能删除。');
            for (const media of ['图片','视频']) { const child = groups.safeDirectory(root, ['assets', version.directory_name, media]); if (child && fs.readdirSync(child).length) throw error('GROUP_NOT_EMPTY', '剧本目录包含文件，不能删除。'); }
            directories.push(directory);
        }
        for (const directory of directories) { for (const media of ['图片','视频']) { const child = path.join(directory, media); if (fs.existsSync(child)) fs.rmdirSync(child); } fs.rmdirSync(directory); }
        db.transaction(() => { db.prepare('DELETE FROM group_drafts WHERE group_id=?').run(groupId); db.prepare('UPDATE workbench_groups SET deleted_at=?,name_key=? WHERE id=?').run(now(), 'retired:' + groupId, groupId); })(); return { groupId, deleted: true };
    }
    function previewHistory(value = {}) {
        input(value, ['groupId']); if (value.groupId) value = { groupId: groups.get(value.groupId).id };
        const items = [];
        for (const current of db.prepare("SELECT DISTINCT t.* FROM tasks t JOIN task_assets ta ON ta.task_id=t.id AND ta.role='output' JOIN assets a ON a.id=ta.asset_id WHERE a.group_id IS NULL ORDER BY t.created_at,t.id").all()) {
            const member = groups.membership(current.id); if (value.groupId && member.group_id !== value.groupId) continue;
            try { const plan = newPlan(current, member.group_id, true, true); items.push({ taskId: current.id, groupId: member.group_id, files: plan.files.map(entry => ({ assetId: entry.source_asset_id, source: sourcePath({ ...entry, root_ref: entry.source_root_ref, storage_key: entry.source_storage_key, group_id: entry.source_group_id }), target: targetPath(entry, false, true) })), conflicts: [] }); }
            catch (cause) { items.push({ taskId: current.id, groupId: member.group_id, files: [], conflicts: [{ code: cause.code || 'FILESYSTEM_ERROR', message: cause.message }] }); }
        }
        return { items, total: items.length };
    }
    function organizeHistory(value) {
        input(value, ['taskIds','requestId']); const requestId = id(value.requestId); if (!Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > 100 || new Set(value.taskIds).size !== value.taskIds.length) throw error('INVALID_STORAGE_INPUT', '请选择1至100条明确预览过的历史任务。', 400);
        value = { ...value, taskIds: value.taskIds.map(id) }; recover();
        let parent = operation(requestId);
        if (parent && (parent.kind !== 'history' || JSON.stringify(JSON.parse(parent.plan_json).task_ids) !== JSON.stringify(value.taskIds))) throw error('GROUP_REQUEST_CONFLICT', '同一历史整理请求编号不能改变选择范围。');
        if (parent?.state === 'completed') return JSON.parse(parent.result_json);
        if (!parent) {
            const operationId = randomUUID(), time = now();
            db.prepare('INSERT INTO group_file_operations(id,request_id,kind,task_id,group_id,state,plan_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(operationId, requestId, 'history', null, DEFAULT_GROUP, 'history-running', JSON.stringify({ task_ids: value.taskIds }), time, time);
            parent = operation(requestId);
        }
        // Each whole task uses the same narrow service. Persist the selected range and
        // report every outcome so an interrupted/partially failed selection stays reviewable.
        const items = [];
        for (const taskId of value.taskIds) {
            try {
                const member = groups.membership(taskId); if (!member) throw error('TASK_NOT_FOUND', '历史任务不存在。', 404);
                const derived = digest(Buffer.from(requestId + ':' + taskId)), childRequest = derived.slice(0,8) + '-' + derived.slice(8,12) + '-4' + derived.slice(13,16) + '-8' + derived.slice(17,20) + '-' + derived.slice(20,32);
                items.push({ ...moveTask(taskId, { groupId: member.group_id, requestId: childRequest }, true), ok: true });
            } catch (cause) { if (cause.simulateCrash) throw cause; items.push({ taskId, ok: false, code: cause.code || 'FILESYSTEM_ERROR', message: cause.message }); }
            db.prepare('UPDATE group_file_operations SET result_json=?,updated_at=? WHERE id=?').run(JSON.stringify({ items }), now(), parent.id);
        }
        const result = { items, succeeded: items.filter(item => item.ok).length, failed: items.filter(item => !item.ok).length };
        setState(parent.id, 'completed', { result }); return result;
    }
    return { moveTask, renameGroup, archiveGroup, deleteGroup, previewHistory, organizeHistory, recover, recoveryStatus };
}
module.exports = { createGroupMoves };
