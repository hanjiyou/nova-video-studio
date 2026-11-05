'use strict';
const { createHash } = require('node:crypto');
const path = require('node:path');
const MAX_WORK_NAME = 60;
const invalid = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
function normalizeWorkName(value) {
    if (typeof value !== 'string' || /[\p{Cc}\p{Cs}]/u.test(value)) throw invalid('WORK_NAME_INVALID', '作品名称不能包含控制字符。');
    const name = value.trim();
    if (Array.from(name).length > MAX_WORK_NAME) throw invalid('WORK_NAME_INVALID', '作品名称最多60个字符。');
    return name;
}
function clip(value, units) {
    let result = '';
    for (const letter of value) { if (result.length + letter.length > units) break; result += letter; }
    return result;
}
function safePart(value, fallback) {
    const cleaned = String(value || '').replace(/[<>:"/\\|?*\p{Cc}\p{Cs}]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/[. ]+$/g, '');
    const result = cleaned && !/^\.+$/.test(cleaned) ? cleaned : fallback;
    return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(result) ? '_' + result : result;
}
function workNameFor(task, snapshot = {}) { return task.work_name ?? snapshot.workName ?? ''; }
function timestampFor(createdAt, existingFilename, existingNamed) {
    // Preserve a previously allocated wall-clock stamp even if the system timezone changes.
    const prefix = String(existingFilename || '').match(/^(\d{8}-\d{6})_/), suffix = String(existingFilename || '').match(/_(\d{8}-\d{6})_[a-f0-9]{12}(?:_\d+){0,2}\.[a-z0-9]{2,5}$/i);
    const old = existingNamed === false ? prefix || suffix : suffix || prefix;
    if (old) return old[1];
    const when = new Date(createdAt);
    if (!Number.isFinite(when.getTime())) throw invalid('OUTPUT_DIRECTORY_INVALID', '任务创建时间无效。', 409);
    const pad = number => String(number).padStart(2, '0');
    return String(when.getFullYear()) + pad(when.getMonth() + 1) + pad(when.getDate()) + '-' + pad(when.getHours()) + pad(when.getMinutes()) + pad(when.getSeconds());
}
function outputFilename({ taskId, createdAt, position = 0, ext, workName = '', prompt = '', media = '图片', existingFilename = '', existingNamed, count = 1, collision = 0, directory = '', maxFilename = 100, maxPath = 240 }) {
    if (!Number.isInteger(position) || position < 0 || position > 31 || !/^[a-z0-9]{2,5}$/.test(ext) || !Number.isInteger(collision) || collision < 0 || collision > 99) throw invalid('ASSET_TYPE_INVALID', '结果文件类型或序号无效。');
    const stamp = timestampFor(createdAt, existingFilename, existingNamed), stable = createHash('sha256').update(taskId + ':' + position).digest('hex').slice(0, 12);
    const named = Boolean(workName);
    let sequence = named ? count > 1 || position ? '_' + String(position + 1).padStart(2, '0') : '' : position ? '_' + (position + 1) : '';
    const allocated = String(existingFilename).match(new RegExp('_' + stable + '((?:_[0-9]+){0,2})\\.' + ext + '$', 'i'));
    if (existingNamed === true && allocated) {
        const parts = allocated[1].split('_').filter(Boolean);
        sequence = position ? Number(parts[0]) === position + 1 ? '_' + parts[0] : sequence : parts[0] === '01' ? '_01' : '';
    }
    const suffix = '_' + stable + sequence + (collision ? '_' + collision : '') + '.' + ext;
    const max = Math.min(maxFilename, directory ? maxPath - directory.length - path.sep.length : maxFilename);
    const fixed = stamp.length + 1 + suffix.length;
    if (max <= fixed) throw invalid('PATH_TOO_LONG', '保存路径过长，请缩短保存根目录或剧本名。', 409);
    const part = clip(safePart(named ? workName : prompt, media), Math.min(named ? Infinity : 24, max - fixed)).replace(/[. ]+$/g, '') || clip(media, max - fixed);
    return named ? part + '_' + stamp + suffix : stamp + '_' + part + suffix;
}
module.exports = { MAX_WORK_NAME, normalizeWorkName, safePart, workNameFor, timestampFor, outputFilename };
