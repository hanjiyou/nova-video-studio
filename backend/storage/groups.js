'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const DEFAULT_GROUP = '00000000-0000-4000-8000-000000000002';
const LIMITS = Object.freeze({ groupName: 48, description: 24, filename: 100, fullPath: 240 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const nameKey = value => value.normalize('NFC').toLowerCase();
function validName(value) {
    if (typeof value !== 'string' || !value || value.length > LIMITS.groupName || /[<>:"/\\|?*\p{Cc}\uD800-\uDFFF]/u.test(value) || /[. ]$/.test(value) || ['.', '..'].includes(value) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]*\.|$)/i.test(value))
        throw invalid('GROUP_NAME_INVALID', '剧本名不能包含路径符号、Windows保留名或末尾点/空格，长度最多48。', 400);
    return value;
}
function bounded(file) {
    if (file.length > LIMITS.fullPath) throw invalid('PATH_TOO_LONG', '保存路径超过240字符，请缩短根目录或剧本名。');
    return file;
}
function contained(root, file) {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function safeDirectory(root, pieces, create = false) {
    // Recheck every component. Windows junctions are reported as symbolic links by lstat.
    if (!fs.statSync(root).isDirectory() || fs.realpathSync.native(root) !== root) throw invalid('ASSET_PATH_REJECTED', '受管根目录已改变，请恢复原目录。');
    let current = root;
    for (const piece of pieces) {
        if (!piece || piece === '.' || piece === '..' || /[\\/]/.test(piece)) throw invalid('ASSET_PATH_REJECTED', '受管文件路径无效。');
        current = bounded(path.join(current, piece));
        if (create && !fs.existsSync(current)) fs.mkdirSync(current);
        if (!fs.existsSync(current)) return null;
        if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory() || fs.realpathSync.native(current) !== current || !contained(root, current)) throw invalid('ASSET_PATH_REJECTED', '受管目录包含联接、链接或越界路径。');
    }
    return current;
}
function safeFile(root, key, strict = false) {
    if (typeof key !== 'string' || path.isAbsolute(key)) throw invalid('ASSET_PATH_REJECTED', '受管文件路径无效。');
    const pieces = key.split(/[\\/]/);
    if (pieces.length !== (strict ? 3 : 2) || pieces.some(part => !part || part === '.' || part === '..')) throw invalid('ASSET_PATH_REJECTED', '受管文件路径无效。');
    if (!strict && !/^[a-f0-9]{2}[\\/][a-f0-9]{64}\.[a-z0-9]+$/.test(key)) throw invalid('ASSET_PATH_REJECTED', '受管文件路径无效。');
    const candidate = path.resolve(root, ...pieces);
    if (!contained(root, candidate)) throw invalid('ASSET_PATH_REJECTED', '受管文件路径无效。');
    if (strict) {
        bounded(candidate);
        if (!safeDirectory(root, pieces.slice(0, -1))) return null;
    }
    if (!fs.existsSync(candidate)) return null;
    const actual = fs.realpathSync.native(candidate);
    if (!contained(root, actual) || fs.lstatSync(candidate).isSymbolicLink() || !fs.statSync(actual).isFile()) throw invalid('ASSET_PATH_REJECTED', '受管文件越界或类型错误。');
    return actual;
}
function probe(directory) {
    const file = bounded(path.join(directory, '.nova-' + randomUUID() + '.part'));
    let fd;
    try { fd = fs.openSync(file, 'wx'); fs.writeSync(fd, 'probe'); fs.fsyncSync(fd); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(file)) fs.unlinkSync(file); }
}
function clipped(value, length) {
    let result = '';
    for (const letter of value) { if (result.length + letter.length > length) break; result += letter; }
    return result;
}
function createGroups({ db, outputDirectories }) {
    function get(id = DEFAULT_GROUP) {
        if (typeof id !== 'string' || !UUID.test(id)) throw invalid('GROUP_NOT_FOUND', '找不到剧本分组。', 404);
        const group = db.prepare('SELECT * FROM workbench_groups WHERE id=?').get(id.toLowerCase());
        if (!group || group.deleted_at) throw invalid('GROUP_NOT_FOUND', '找不到剧本分组。', 404);
        return group;
    }
    function mapped(groupId, rootRef) {
        return db.prepare('SELECT v.* FROM group_directory_current c JOIN group_directory_versions v ON v.id=c.version_id WHERE c.group_id=? AND c.root_ref=?').get(groupId, rootRef);
    }
    function ensure(groupId, rootRef) {
        const group = get(groupId), root = outputDirectories.directory(rootRef);
        const assets = safeDirectory(root, ['assets'], true);
        let version = mapped(group.id, rootRef);
        if (!version) {
            const alias = db.prepare('SELECT v.* FROM group_directory_current c JOIN group_directory_versions v ON v.id=c.version_id JOIN storage_roots r ON r.id=c.root_ref WHERE c.group_id=? AND r.directory=? LIMIT 1').get(group.id, root);
            // An existing directory is never silently claimed, including case-only aliases.
            if (!alias && fs.readdirSync(assets).some(name => nameKey(name) === nameKey(group.name))) throw invalid('GROUP_DIRECTORY_CONFLICT', '同名目录已存在且不属于此分组，请更名或先整理该目录。');
            bounded(path.join(assets, group.name, '图片', 'x'.repeat(LIMITS.filename)));
            bounded(path.join(assets, group.name, '视频', 'x'.repeat(LIMITS.filename)));
            const groupDir = safeDirectory(root, ['assets', group.name], true);
            safeDirectory(root, ['assets', group.name, '图片'], true);
            safeDirectory(root, ['assets', group.name, '视频'], true);
            version = { id: randomUUID(), group_id: group.id, root_ref: rootRef, directory_name: group.name, created_at: new Date().toISOString() };
            try {
                db.transaction(() => {
                    db.prepare('INSERT INTO group_directory_versions VALUES(?,?,?,?,?)').run(version.id, group.id, rootRef, group.name, version.created_at);
                    db.prepare('INSERT INTO group_directory_current VALUES(?,?,?)').run(group.id, rootRef, version.id);
                })();
            } catch (error) {
                // Remove only our empty directories. Never recursively delete a user's files.
                for (const child of alias ? [] : ['图片', '视频']) { try { fs.rmdirSync(path.join(groupDir, child)); } catch {} }
                if (!alias) { try { fs.rmdirSync(groupDir); } catch {} }
                throw error;
            }
        } else {
            safeDirectory(root, ['assets', version.directory_name], true);
            safeDirectory(root, ['assets', version.directory_name, '图片'], true);
            safeDirectory(root, ['assets', version.directory_name, '视频'], true);
        }
        return version;
    }
    function view(group, rootRef = outputDirectories.current().outputRootRef) {
        const root = db.prepare('SELECT directory FROM storage_roots WHERE id=?').get(rootRef);
        const version = mapped(group.id, rootRef);
        return { groupId: group.id, name: group.name, isDefault: Boolean(group.is_default), archived: Boolean(group.archived_at), createdAt: group.created_at, outputLocation: root ? path.join(root.directory, 'assets', version?.directory_name || group.name) : null };
    }
    function create(value) {
        if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => key !== 'name')) throw invalid('INVALID_STORAGE_INPUT', '分组请求无效。', 400);
        const name = validName(value.name);
        if (db.prepare('SELECT 1 FROM workbench_groups WHERE name_key=?').get(nameKey(name))) throw invalid('GROUP_NAME_CONFLICT', '已存在同名剧本分组，请使用其他名称。');
        const group = { id: randomUUID(), name, name_key: nameKey(name), is_default: 0, created_at: new Date().toISOString() };
        db.transaction(() => {
            db.prepare('INSERT INTO workbench_groups(id,name,name_key,is_default,created_at) VALUES(?,?,?,?,?)').run(group.id, name, group.name_key, 0, group.created_at);
            ensure(group.id, outputDirectories.current().outputRootRef);
        })();
        return view(group);
    }
    function freeze(snapshot) {
        const selected = outputDirectories.freeze(snapshot), group = get(snapshot.groupId || DEFAULT_GROUP);
        if (group.archived_at) throw invalid('GROUP_ARCHIVED', '剧本已归档，请先取消归档。');
        let version;
        if (snapshot.groupDirectoryVersionId) {
            version = db.prepare('SELECT * FROM group_directory_versions WHERE id=?').get(snapshot.groupDirectoryVersionId);
            if (!version || version.group_id !== group.id || version.root_ref !== selected.outputRootRef) throw invalid('OUTPUT_DIRECTORY_INVALID', '分组目录版本与所选剧本或根目录不符。');
        } else version = ensure(group.id, selected.outputRootRef);
        if (snapshot.groupName !== undefined && snapshot.groupName !== version.directory_name) throw invalid('INPUT_INVALID', '剧本名称与提交目录版本不符。', 400);
        const root = outputDirectories.directory(version.root_ref), media = String(snapshot.mode).startsWith('image.') || ['text-to-image','image-to-image'].includes(snapshot.mode) ? '图片' : '视频';
        const destination = safeDirectory(root, ['assets', version.directory_name, media], true);
        bounded(path.join(destination, 'x'.repeat(LIMITS.filename)));
        probe(destination);
        const temporary = safeDirectory(root, ['.nova-parts'], true); probe(temporary);
        return { ...selected, groupId: group.id, groupName: version.directory_name, groupDirectoryVersionId: version.id };
    }
    function membership(taskId) {
        return db.prepare('SELECT m.*,g.name,v.directory_name,v.root_ref FROM task_group_memberships m JOIN workbench_groups g ON g.id=m.group_id LEFT JOIN group_directory_versions v ON v.id=m.directory_version_id WHERE m.task_id=?').get(taskId);
    }
    function attach(taskId, snapshot) {
        if (!snapshot.groupId) return; // Existing legacy snapshots remain byte-for-byte unchanged.
        const group = get(snapshot.groupId), version = db.prepare('SELECT * FROM group_directory_versions WHERE id=?').get(snapshot.groupDirectoryVersionId);
        if (!version || version.group_id !== group.id || version.root_ref !== snapshot.outputRootRef || version.directory_name !== snapshot.groupName) throw invalid('OUTPUT_DIRECTORY_INVALID', '任务分组目录版本无效。');
        db.prepare('UPDATE task_group_memberships SET group_id=?,directory_version_id=? WHERE task_id=?').run(group.id, version.id, taskId);
    }
    function location(task, position, ext) {
        if (!Number.isInteger(position) || position < 0 || position > 31 || !/^[a-z0-9]{2,5}$/.test(ext)) throw invalid('ASSET_TYPE_INVALID', '结果文件类型或序号无效。', 400);
        const member = membership(task.id), snapshot = JSON.parse(task.input_snapshot_json || '{}');
        if (!member?.directory_version_id) return null;
        if (!member?.directory_version_id) throw invalid('OUTPUT_DIRECTORY_INVALID', '任务当前分组目录缺失。');
        const root = outputDirectories.directory(member.root_ref), media = task.execution_media_kind === 'image' || String(snapshot.mode).startsWith('image.') ? '图片' : '视频';
        const directory = safeDirectory(root, ['assets', member.directory_name, media], true);
        const prior = db.prepare('SELECT * FROM task_output_locations WHERE task_id=? AND position=?').get(task.id, position);
        if (prior) {
            if (prior.root_ref !== member.root_ref || prior.group_id !== member.group_id || prior.directory_version_id !== member.directory_version_id || path.extname(prior.storage_key) !== '.' + ext) throw invalid('OUTPUT_DIRECTORY_INVALID', '结果位置与任务当前归属不一致。');
            bounded(path.join(root, 'assets', prior.storage_key));
            return prior;
        }
        const when = new Date(task.created_at);
        if (!Number.isFinite(when.getTime())) throw invalid('OUTPUT_DIRECTORY_INVALID', '任务创建时间无效。');
        const pad = number => String(number).padStart(2, '0');
        const timestamp = String(when.getFullYear()) + pad(when.getMonth()+1) + pad(when.getDate()) + '-' + pad(when.getHours()) + pad(when.getMinutes()) + pad(when.getSeconds());
        const description = clipped(String(snapshot.prompt || '').replace(/[<>:"/\\|?*\p{Cc}\uD800-\uDFFF]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/[. ]+$/g, ''), LIMITS.description) || media;
        const stable = createHash('sha256').update(task.id + ':' + position).digest('hex').slice(0, 12);
        const stem = timestamp + '_' + description + '_' + stable + (position ? '_' + (position + 1) : '');
        for (let collision = 0; collision < 100; collision++) {
            const filename = stem + (collision ? '_' + collision : '') + '.' + ext;
            if (filename.length > LIMITS.filename) throw invalid('PATH_TOO_LONG', '结果文件名过长。');
            const storageKey = path.join(member.directory_name, media, filename);
            const target = bounded(path.join(directory, filename));
            if (fs.existsSync(target) || db.prepare('SELECT 1 FROM assets WHERE root_ref IS ? AND storage_key=? UNION ALL SELECT 1 FROM task_output_locations WHERE root_ref=? AND storage_key=?').get(member.root_ref, storageKey, member.root_ref, storageKey)) continue;
            const entry = { task_id: task.id, position, root_ref: member.root_ref, group_id: member.group_id, directory_version_id: member.directory_version_id, storage_key: storageKey };
            db.prepare('INSERT INTO task_output_locations VALUES(?,?,?,?,?,?)').run(task.id, position, member.root_ref, member.group_id, member.directory_version_id, storageKey);
            return entry;
        }
        throw invalid('ASSET_FILE_CONFLICT', '目标文件名冲突，请整理目标目录后重试。');
    }
    return { DEFAULT_GROUP, get, view, create, ensure, freeze, membership, attach, location, list: () => ({ items: db.prepare('SELECT * FROM workbench_groups WHERE deleted_at IS NULL ORDER BY is_default DESC,created_at,id').all().map(group => view(group)), defaultGroupId: DEFAULT_GROUP }), safeDirectory, safeFile };
}
module.exports = { createGroups, DEFAULT_GROUP, LIMITS, validName, bounded, safeDirectory, safeFile };
