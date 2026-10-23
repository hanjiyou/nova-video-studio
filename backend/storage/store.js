'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createOutputDirectories } = require('./output-directories');
const { fileFailure } = require('./download-errors');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = new Set(['image.text', 'image.reference', 'video.text', 'video.single_reference', 'video.dual_reference']);
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };
const MAX_ASSET_BYTES = 100 * 1024 * 1024; // Application budget, not a provider capability.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code, message = '存储请求无效。', statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value))
    throw fail('INVALID_ID'); return value; }
function exactKeys(value, keys) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key)))
        throw fail('INVALID_STORAGE_INPUT');
}
function safeJson(value, maxBytes = 65536) {
    function visit(item, depth) {
        if (depth > 12)
            throw fail('INVALID_STORAGE_INPUT');
        if (item === null || typeof item === 'boolean' || typeof item === 'string')
            return;
        if (typeof item === 'number' && Number.isFinite(item))
            return;
        if (Array.isArray(item)) {
            if (item.length > 256)
                throw fail('INVALID_STORAGE_INPUT');
            item.forEach(child => visit(child, depth + 1));
            return;
        }
        if (!item || Object.getPrototypeOf(item) !== Object.prototype)
            throw fail('INVALID_STORAGE_INPUT');
        for (const [key, child] of Object.entries(item)) {
            if (/api.?key|authorization|token|secret|password|credential|base64|(^|_)path$|filePath|directory|(^|_)url$/i.test(key))
                throw fail('SENSITIVE_STORAGE_FIELD', '此存储接口不接收凭据、路径或原始响应。');
            visit(child, depth + 1);
        }
    }
    visit(value, 0);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > maxBytes)
        throw fail('STORAGE_INPUT_TOO_LARGE');
    return json;
}
function createWorkbenchStore({ db, rootDirectory }) {
    const root = path.resolve(rootDirectory);
    const assetRoot = path.join(root, 'assets');
    fs.mkdirSync(assetRoot, { recursive: true });
    const canonicalRoot = fs.realpathSync.native(assetRoot);
    const outputDirectories = createOutputDirectories({ db, defaultDirectory: root });
    function objectsFor(ref) {
        if (!ref || ref === outputDirectories.DEFAULT) return canonicalRoot;
        const base = outputDirectories.directory(ref), objects = path.join(base, 'assets');
        return objects;
    }
    function row(id) { return db.prepare('SELECT * FROM assets WHERE id=?').get(uuid(id)); }
    function trustedPath(asset) {
        if (!asset || !/^[a-f0-9]{2}[\\/][a-f0-9]{64}\.[a-z0-9]+$/.test(asset.storage_key))
            throw fail('ASSET_PATH_REJECTED');
        let managedRoot;
        try { managedRoot = objectsFor(asset.root_ref); } catch (error) { if (error.code === 'DIRECTORY_NOT_WRITABLE') return null; throw error; }
        const candidate = path.resolve(managedRoot, asset.storage_key);
        if (!candidate.startsWith(managedRoot + path.sep))
            throw fail('ASSET_PATH_REJECTED');
        if (!fs.existsSync(candidate))
            return null;
        const actual = fs.realpathSync.native(candidate);
        if (!actual.startsWith(managedRoot + path.sep) || fs.lstatSync(candidate).isSymbolicLink() || !fs.statSync(actual).isFile())
            throw fail('ASSET_PATH_REJECTED');
        return actual;
    }
    function summary(asset) {
        if (!asset)
            return null;
        const exists = Boolean(trustedPath(asset));
        const availability = exists ? (asset.availability === 'missing' ? 'available' : asset.availability) : 'missing';
        if (availability !== asset.availability)
            db.prepare('UPDATE assets SET availability=? WHERE id=?').run(availability, asset.id);
        return { assetId: asset.id, kind: asset.kind, displayName: asset.display_name, mimeType: asset.mime_type,
            byteLength: asset.byte_length, sha256: asset.sha256, width: asset.width, height: asset.height, durationSeconds: asset.duration_seconds,
            validationState: asset.validation_state, availability, createdAt: asset.created_at, previewUrl: '/api/nova/assets/' + asset.id + '/content' };
    }
    function importBuffer(bytes, { mimeType, displayName = 'asset', sourceKind = 'imported', rootRef = null, validation = null } = {}) {
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ASSET_BYTES)
            throw fail('ASSET_SIZE_INVALID');
        const rawMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
        const mime = ({ 'image/jpg': 'image/jpeg', 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4' })[rawMime] || rawMime;
        const ext = MIME_EXT[mime];
        if (!ext || !['imported', 'generated', 'legacy'].includes(sourceKind))
            throw fail('ASSET_TYPE_INVALID');
        const kind = mime.split('/')[0];
        const sha = digest(bytes);
        const storageKey = path.join(sha.slice(0, 2), sha + '.' + ext);
        rootRef = rootRef === outputDirectories.DEFAULT ? null : rootRef;
        const objectRoot = objectsFor(rootRef);
        const directory = path.join(objectRoot, sha.slice(0, 2));
        fs.mkdirSync(directory, { recursive: true });
        if (!fs.realpathSync.native(directory).startsWith(objectRoot + path.sep))
            throw fail('ASSET_PATH_REJECTED');
        const destination = path.join(objectRoot, storageKey);
        const existing = db.prepare('SELECT * FROM assets WHERE root_ref IS ? AND sha256=? AND mime_type=? AND kind=?').get(rootRef, sha, mime, kind);
        if (fs.existsSync(destination)) {
            if (fs.lstatSync(destination).isSymbolicLink() || digest(fs.readFileSync(destination)) !== sha)
                throw fail('ASSET_FILE_CONFLICT', '受管理文件与记录不一致，原文件已保留。', 409);
        }
        else {
            const temporary = path.join(directory, '.' + randomUUID() + '.part');
            let fd;
            try {
                fd = fs.openSync(temporary, 'wx');
                fs.writeFileSync(fd, bytes);
                fs.fsyncSync(fd);
                fs.closeSync(fd);
                fd = undefined;
                // Atomic, exclusive publication. A collision is never overwritten.
                try {
                    fs.linkSync(temporary, destination);
                }
                catch (error) {
                    if (error.code !== 'EEXIST' || digest(fs.readFileSync(destination)) !== sha)
                        throw error;
                }
            }
            finally {
                if (fd !== undefined)
                    fs.closeSync(fd);
                if (fs.existsSync(temporary))
                    fs.unlinkSync(temporary);
            }
        }
        if (existing) {
            db.prepare("UPDATE assets SET availability='available' WHERE id=?").run(existing.id);
            if (validation) db.prepare("UPDATE assets SET validation_state='verified',width=?,height=?,duration_seconds=? WHERE id=?").run(validation.width, validation.height, validation.durationSeconds ?? null, existing.id);
            return summary(row(existing.id));
        }
        const id = randomUUID();
        const name = path.basename(String(displayName)).replace(/\p{Cc}/gu, '').slice(0, 240) || 'asset';
        const width = mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? bytes.readUInt32BE(16) : null;
        const height = width ? bytes.readUInt32BE(20) : null;
        db.prepare(`INSERT INTO assets(id,kind,storage_key,display_name,mime_type,byte_length,sha256,width,height,source_kind,created_at,root_ref,validation_state,duration_seconds)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, kind, storageKey, name, mime, bytes.length, sha, validation?.width ?? width, validation?.height ?? height, sourceKind, new Date().toISOString(), rootRef, validation ? 'verified' : 'unverified', validation?.durationSeconds ?? null);
        return summary(row(id));
    }
    function importFile(filePath, options = {}) {
        // Host-only entry. HTTP/IPC callers cannot supply this path.
        const source = fs.realpathSync.native(filePath);
        const stat = fs.statSync(source);
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ASSET_BYTES)
            throw fail('ASSET_SIZE_INVALID');
        const mime = options.mimeType || Object.entries(MIME_EXT).find(([, extension]) => '.' + extension === path.extname(source).toLowerCase())?.[0]
            || (/\.jpeg$/i.test(source) ? 'image/jpeg' : null);
        return importBuffer(fs.readFileSync(source), { ...options, mimeType: mime, displayName: options.displayName || path.basename(source) });
    }
    function readAsset(id) {
        const asset = row(id);
        if (!asset)
            throw fail('ASSET_NOT_FOUND', '找不到素材。', 404);
        const file = trustedPath(asset);
        if (!file) {
            db.prepare("UPDATE assets SET availability='missing' WHERE id=?").run(id);
            throw fail('ASSET_MISSING', '素材文件缺失，记录已保留。', 404);
        }
        const bytes = fs.readFileSync(file);
        if (bytes.length !== asset.byte_length || digest(bytes) !== asset.sha256) {
            db.prepare("UPDATE assets SET availability='corrupt' WHERE id=?").run(id);
            throw fail('ASSET_CORRUPT', '素材文件与摘要不符，记录已保留。', 409);
        }
        if(asset.availability!=='available'){db.prepare("UPDATE assets SET availability='available' WHERE id=?").run(id);asset.availability='available';}
        return { bytes, asset: summary(asset) };
    }
    function references(items) {
        if (!Array.isArray(items) || items.length > 32)
            throw fail('INVALID_ASSET_ORDER');
        return items.map((item, index) => {
            exactKeys(item, ['assetId', 'position', 'role']);
            if (item.position !== index || item.role !== 'reference' || !row(item.assetId))
                throw fail('INVALID_ASSET_ORDER');
            return { assetId: uuid(item.assetId), position: index, role: 'reference' };
        });
    }
    function taskAssets(taskId, role = 'input') {
        if (!['input', 'output'].includes(role))
            throw fail('INVALID_ASSET_ROLE');
        return db.prepare('SELECT a.*,ta.position FROM task_assets ta JOIN assets a ON a.id=ta.asset_id WHERE ta.task_id=? AND ta.role=? ORDER BY ta.position').all(uuid(taskId), role)
            .map(asset => ({ ...summary(asset), position: asset.position, role: role === 'input' ? 'reference' : 'result' }));
    }
    function bindTaskAssets(taskId, items, role = 'input') {
        uuid(taskId);
        const checked = references(items);
        if (!['input', 'output'].includes(role))
            throw fail('INVALID_ASSET_ROLE');
        db.transaction(() => {
            const task = db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(taskId);
            if (!task)
                throw fail('TASK_NOT_FOUND');
            if (role === 'input' && task.input_snapshot_json && JSON.stringify(JSON.parse(task.input_snapshot_json).inputAssets) !== JSON.stringify(checked))
                throw fail('IMMUTABLE_TASK_INPUTS');
            db.prepare('DELETE FROM task_assets WHERE task_id=? AND role=?').run(taskId, role);
            const insert = db.prepare('INSERT INTO task_assets(task_id,asset_id,role,position) VALUES(?,?,?,?)');
            for (const item of checked)
                insert.run(taskId, item.assetId, role, item.position);
        })();
    }
    function appendTaskEvent(taskId, type, payload = {}) {
        uuid(taskId);
        if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(type))
            throw fail('INVALID_EVENT_TYPE');
        db.prepare('INSERT INTO task_events(task_id,type,payload_json,created_at) VALUES(?,?,?,?)').run(taskId, type, safeJson(payload, 8192), new Date().toISOString());
    }
    function setTaskSnapshot(taskId, snapshot) {
        uuid(taskId);
        exactKeys(snapshot, ['contractVersion', 'localRequestId', 'connectionVersionId', 'capabilityVersionId', 'mode', 'model', 'prompt', 'parameters', 'inputAssets', 'adapterId', 'adapterVersion', 'outputDirectoryVersionId', 'outputRootRef']);
        if (snapshot.contractVersion !== 1 || ![...MODES, 'legacy.plugin'].includes(snapshot.mode) || typeof snapshot.prompt !== 'string' || snapshot.prompt.length > 65536 || typeof snapshot.model !== 'string' || !snapshot.model || snapshot.model.length > 256)
            throw fail('INVALID_TASK_SNAPSHOT');
        for (const field of ['adapterId', 'adapterVersion'])
            if (snapshot[field] !== undefined && (typeof snapshot[field] !== 'string' || snapshot[field].length > 128))
                throw fail('INVALID_TASK_SNAPSHOT');
        const input = references(snapshot.inputAssets || []);
        for (const field of ['localRequestId', 'connectionVersionId', 'capabilityVersionId', 'outputDirectoryVersionId', 'outputRootRef'])
            if (snapshot[field] != null)
                uuid(snapshot[field]);
        const json = JSON.stringify({ ...snapshot, inputAssets: input });
        if (Buffer.byteLength(json) > 262144)
            throw fail('STORAGE_INPUT_TOO_LARGE');
        safeJson(snapshot.parameters || {});
        db.transaction(() => {
            const task = db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(taskId);
            if (!task)
                throw fail('TASK_NOT_FOUND');
            if (task.input_snapshot_json) {
                if (task.input_snapshot_json !== json)
                    throw fail('IMMUTABLE_TASK_SNAPSHOT');
                return;
            }
            db.prepare(`UPDATE tasks SET input_snapshot_json=?,local_request_id=?,connection_version_id=?,capability_version_id=?,adapter_id=?,adapter_version=?,output_directory_version_id=?,output_root_ref=? WHERE id=?`)
                .run(json, snapshot.localRequestId || null, snapshot.connectionVersionId || null, snapshot.capabilityVersionId || null, snapshot.adapterId || null, snapshot.adapterVersion || null, snapshot.outputDirectoryVersionId || null, snapshot.outputRootRef || null, taskId);
            bindTaskAssets(taskId, input);
        })();
    }
    function getDraft(mode) {
        if (!MODES.has(mode))
            throw fail('INVALID_DRAFT_MODE');
        const draft = db.prepare('SELECT * FROM drafts WHERE mode=?').get(mode);
        if (!draft)
            return { mode, prompt: '', model: '', parameters: {}, inputAssets: [], revision: 0, updatedAt: null };
        const assets = db.prepare('SELECT a.*,da.position FROM draft_assets da JOIN assets a ON a.id=da.asset_id WHERE da.mode=? ORDER BY da.position').all(mode);
        return { mode, prompt: draft.prompt, model: draft.model, parameters: JSON.parse(draft.parameters_json), revision: draft.revision, updatedAt: draft.updated_at,
            inputAssets: assets.map(asset => ({ ...summary(asset), position: asset.position, role: 'reference' })) };
    }
    function putDraft(mode, value) {
        if (!MODES.has(mode))
            throw fail('INVALID_DRAFT_MODE');
        exactKeys(value, ['prompt', 'model', 'parameters', 'inputAssets', 'expectedRevision']);
        if (typeof value.prompt !== 'string' || value.prompt.length > 65536 || typeof value.model !== 'string' || value.model.length > 256)
            throw fail('INVALID_DRAFT');
        const parameters = safeJson(value.parameters || {});
        const input = references(value.inputAssets || []);
        db.transaction(() => {
            const previous = db.prepare('SELECT revision FROM drafts WHERE mode=?').get(mode);
            if (value.expectedRevision !== undefined && value.expectedRevision !== (previous?.revision || 0))
                throw fail('DRAFT_REVISION_CONFLICT', '草稿已更新，请先读取最新版本。', 409);
            db.prepare(`INSERT INTO drafts VALUES(?,?,?,?,?,?) ON CONFLICT(mode) DO UPDATE SET prompt=excluded.prompt,model=excluded.model,parameters_json=excluded.parameters_json,revision=excluded.revision,updated_at=excluded.updated_at`)
                .run(mode, value.prompt, value.model, parameters, (previous?.revision || 0) + 1, new Date().toISOString());
            db.prepare('DELETE FROM draft_assets WHERE mode=?').run(mode);
            const insert = db.prepare('INSERT INTO draft_assets VALUES(?,?,?)');
            for (const item of input)
                insert.run(mode, item.assetId, item.position);
        })();
        return getDraft(mode);
    }
    function putSetting(key, value) {
        exactKeys(value, ['value', 'expectedRevision']);
        if (!['theme', 'workspace', 'onboarding'].includes(key))
            throw fail('INVALID_SETTING_KEY');
        if (key === 'theme' && !['system', 'light', 'dark'].includes(value.value))
            throw fail('INVALID_SETTING_VALUE');
        if (key === 'workspace') {
            exactKeys(value.value, ['wideMode', 'activeMode', 'activePage', 'returnPage']);
            if (value.value.wideMode !== undefined && typeof value.value.wideMode !== 'boolean')
                throw fail('INVALID_SETTING_VALUE');
            if (value.value.activeMode !== undefined && !MODES.has(value.value.activeMode))
                throw fail('INVALID_SETTING_VALUE');
        }
        if (key === 'workspace' && value.value.activePage !== undefined && !['image','video','library','settings'].includes(value.value.activePage)) throw fail('INVALID_SETTING_VALUE');
        if (key === 'workspace' && value.value.returnPage !== undefined && !['image','video','library'].includes(value.value.returnPage)) throw fail('INVALID_SETTING_VALUE');
        if (key === 'onboarding') {
            exactKeys(value.value, ['dismissed', 'step']);
            if (value.value.dismissed !== undefined && typeof value.value.dismissed !== 'boolean')
                throw fail('INVALID_SETTING_VALUE');
            if (value.value.step !== undefined && (typeof value.value.step !== 'string' || value.value.step.length > 64))
                throw fail('INVALID_SETTING_VALUE');
        }
        const json = safeJson(value.value);
        db.transaction(() => {
            const previous = db.prepare('SELECT revision FROM app_settings WHERE key=?').get(key);
            if (value.expectedRevision !== undefined && value.expectedRevision !== (previous?.revision || 0))
                throw fail('SETTING_REVISION_CONFLICT', '设置已更新。', 409);
            db.prepare(`INSERT INTO app_settings VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at`).run(key, json, (previous?.revision || 0) + 1, new Date().toISOString());
        })();
        return getSetting(key);
    }
    function getSetting(key) {
        if (!['theme', 'workspace', 'onboarding'].includes(key))
            throw fail('INVALID_SETTING_KEY');
        const item = db.prepare('SELECT * FROM app_settings WHERE key=?').get(key);
        return item ? { key, value: JSON.parse(item.value_json), revision: item.revision, updatedAt: item.updated_at } : { key, value: null, revision: 0, updatedAt: null };
    }
    function linkLegacyAsset(kind, relativeKey, assetId) {
        if (!['image', 'plugin-media'].includes(kind) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(relativeKey) || relativeKey.includes('..'))
            throw fail('INVALID_LEGACY_ASSET');
        const asset = summary(row(assetId));
        if (!asset)
            throw fail('ASSET_NOT_FOUND');
        const existing = db.prepare('SELECT asset_id FROM asset_legacy_links WHERE kind=? AND relative_key=?').get(kind, relativeKey);
        if (existing && existing.asset_id !== asset.assetId)
            throw fail('LEGACY_ASSET_CONFLICT', '原素材映射冲突，未覆盖。', 409);
        db.prepare('INSERT OR IGNORE INTO asset_legacy_links VALUES(?,?,?)').run(kind, relativeKey, asset.assetId);
        if (kind === 'image') {
            const match = relativeKey.match(/^([a-f0-9-]{36})-(\d+)-(\d+)\./i);
            if (match && db.prepare('SELECT 1 FROM tasks WHERE id=?').get(match[1])) {
                const links = db.prepare("SELECT relative_key,asset_id FROM asset_legacy_links WHERE kind='image' AND relative_key LIKE ?").all(match[1] + '-%')
                    .map(link => ({ ...link, parts: link.relative_key.match(/^[a-f0-9-]{36}-(\d+)-(\d+)\./i) })).filter(link => link.parts)
                    .sort((a, b) => Number(a.parts[1]) - Number(b.parts[1]) || Number(a.parts[2]) - Number(b.parts[2]));
                bindTaskAssets(match[1], links.map((link, position) => ({ assetId: link.asset_id, position, role: 'reference' })), 'output');
            }
        }
        return asset;
    }
    function registerLegacyFile(kind, relativeKey, sourcePath, mimeType) {
        return db.transaction(() => linkLegacyAsset(kind, relativeKey, importFile(sourcePath, { mimeType, displayName: relativeKey, sourceKind: 'legacy' }).assetId))();
    }
    function legacyAsset(kind, relativeKey) { const link = db.prepare('SELECT asset_id FROM asset_legacy_links WHERE kind=? AND relative_key=?').get(kind, relativeKey); return link ? summary(row(link.asset_id)) : null; }
    function legacyImage(taskId, index) {
        uuid(taskId);
        if (!Number.isInteger(index) || index < 0)
            throw fail('INVALID_IMAGE_INDEX');
        const link = db.prepare("SELECT asset_id FROM asset_legacy_links WHERE kind='image' AND relative_key LIKE ? ORDER BY relative_key LIMIT 1").get(taskId + '-' + index + '-%');
        return link ? summary(row(link.asset_id)) : null;
    }
    function record(task) {
        let request = {};
        try {
            request = JSON.parse(task.input_snapshot_json || task.request_json);
        }
        catch { /* Preserve unreadable legacy metadata without inventing fields. */ }
        const reserved = ['submitting','submission_unknown','remote_queued','generating','polling_paused'].includes(task.status) && Boolean(task.dispatch_started_at || task.upstream_task_id);
        const rootRow = db.prepare('SELECT directory FROM storage_roots WHERE id=?').get(task.output_root_ref || outputDirectories.DEFAULT);
        return { id: task.id, localTaskId: task.id, status: task.status, mode: request.mode || task.mode, prompt: typeof request.prompt === 'string' ? request.prompt : '', model: typeof request.model === 'string' ? request.model : '', parameters: request.parameters || {}, capabilityVersionId: task.capability_version_id, createdAt: task.created_at, completedAt: task.completed_at, expiresAt: null,
            localRequestId: task.local_request_id, connectionVersionId: task.connection_version_id, upstreamTaskId: task.upstream_task_id,
            outputDirectoryVersionId:task.output_directory_version_id,outputRootRef:task.output_root_ref,
            outputLocation: rootRow ? path.basename(rootRow.directory) : null,
            generationReserved: reserved, remoteMayContinue: reserved && ['submission_unknown','polling_paused'].includes(task.status),
            remoteState: task.remote_state, rawStatus: task.raw_status, pauseReason: task.pause_reason, notBeforeAt: task.not_before_at, requiresContinue: Boolean(task.requires_continue),
            taskError: task.task_error_json ? JSON.parse(task.task_error_json) : null, inputAssets: taskAssets(task.id), outputAssets: taskAssets(task.id, 'output') };
    }
    function listTasks({ limit = 50, offset = 0, kind = '', search = '', model = '', status = '' } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0)
            throw fail('INVALID_PAGINATION');
        if (!['','image','video'].includes(kind) || [search,model,status].some(value => typeof value !== 'string' || value.length > 512)) throw fail('INVALID_HISTORY_FILTER');
        const where = ['NOT EXISTS (SELECT 1 FROM workbench_hidden_tasks h WHERE h.task_id=tasks.id)'], args = [];
        const value = field => `COALESCE(json_extract(CASE WHEN json_valid(input_snapshot_json) THEN input_snapshot_json ELSE '{}' END,'$.${field}'),json_extract(CASE WHEN json_valid(request_json) THEN request_json ELSE '{}' END,'$.${field}'),'')`;
        if (kind) { where.push(kind === 'image' ? "(mode LIKE 'image.%' OR mode IN ('text-to-image','image-to-image'))" : "(mode LIKE 'video.%' OR mode='plugin')"); }
        if (search) { where.push(`(instr(lower(${value('prompt')}),lower(?))>0 OR instr(lower(${value('model')}),lower(?))>0)`); args.push(search,search); }
        if (model) { where.push(value('model')+'=?'); args.push(model); }
        if (status) { where.push('status=?'); args.push(status); }
        const clause = ' WHERE '+where.join(' AND ');
        return { items: db.prepare('SELECT * FROM tasks'+clause+' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(...args,limit,offset).map(record), total: db.prepare('SELECT count(*) AS n FROM tasks'+clause).get(...args).n, unfilteredTotal: db.prepare('SELECT count(*) AS n FROM tasks WHERE '+where[0]).get().n };
    }
    const importFiles = files => { if (!Array.isArray(files) || files.length > 32)
        throw fail('INVALID_IMPORT_SELECTION'); return db.transaction(() => files.map(file => importFile(file)))(); };
    const service = { importBuffer, importFile, importFiles, readAsset, getAsset: id => summary(row(id)), bindTaskAssets, taskAssets, appendTaskEvent, setTaskSnapshot,
        outputDirectory: () => outputDirectories.current(), checkOutputDirectory: () => outputDirectories.checkCurrent(), selectOutputDirectory: directory => outputDirectories.select(directory),
        freezeOutputDirectory: snapshot => outputDirectories.freeze(snapshot),
        downloadDirectory: rootRef => {
            const directory = path.join(outputDirectories.directory(rootRef || outputDirectories.DEFAULT), '.nova-parts');
            fs.mkdirSync(directory, { recursive: true });
            if (fs.realpathSync.native(directory) !== directory) throw fail('ASSET_PATH_REJECTED');
            return directory;
        },
        publishVerifiedFile: (file, metadata, rootRef) => {
            const bytes = fs.readFileSync(file);
            if (digest(bytes) !== metadata.sha256) throw fail('ASSET_CORRUPT');
            if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width < 1 || metadata.height < 1) throw fail('MEDIA_INVALID');
            return importBuffer(bytes, { mimeType: metadata.mimeType, sourceKind: 'generated', rootRef, validation: metadata });
        },
        getDraft, putDraft, getSetting, putSetting, registerLegacyFile, linkLegacyAsset, legacyAsset, legacyImage, listTasks,
        getTask: id => { const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(uuid(id)); return task ? record(task) : null; },
        ...require('./workbench-library').createWorkbenchLibrary({ db, getTask: id => { const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(uuid(id)); return task ? record(task) : null; }, readAsset, trustedPath, row, freeze: snapshot => outputDirectories.freeze(snapshot) }),
        events: id => db.prepare('SELECT id,type,payload_json,created_at FROM task_events WHERE task_id=? ORDER BY id').all(uuid(id)).map(item => ({ id: item.id, type: item.type, payload: JSON.parse(item.payload_json), createdAt: item.created_at })),
        resolveAssetPath: id => { const asset = row(id); if (!asset)
            throw fail('ASSET_NOT_FOUND', '找不到素材。', 404); const file = trustedPath(asset); if (!file)
            throw fail('ASSET_MISSING', '素材文件缺失。', 404); return file; },
        countReferences: id => db.prepare('SELECT (SELECT count(*) FROM task_assets WHERE asset_id=?) + (SELECT count(*) FROM draft_assets WHERE asset_id=?) AS n').get(uuid(id), id).n,
        deleteTaskHistory: id => db.transaction(() => { uuid(id); db.prepare('DELETE FROM task_items WHERE task_id=?').run(id); db.prepare('DELETE FROM tasks WHERE id=?').run(id); })(),
    };
    return Object.fromEntries(Object.entries(service).map(([name, method]) => [name, (...args) => {
            try {
                return method(...args);
            }
            catch (cause) {
                if (cause.statusCode)
                    throw cause;
                if (['ENOSPC','EDQUOT','EBUSY','EPERM','ETXTBSY','EACCES','ENOENT','ENOTDIR','ENAMETOOLONG'].includes(cause.code)) throw fileFailure(cause);
                throw Object.assign(fail('STORAGE_OPERATION_FAILED', '存储操作失败，已有记录和文件保留。', 500), { cause });
            }
        }]));
}
module.exports = { createWorkbenchStore, UUID, MODES, MIME_EXT, MAX_ASSET_BYTES, fail, safeJson };
