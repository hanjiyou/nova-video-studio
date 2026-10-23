'use strict';
const { randomUUID } = require('node:crypto');
const { UUID } = require('../storage/store');
const { OPENSOSEN_URL, PRESET_MODELS, normalizeBaseUrl, seedCapabilities, listCapabilities } = require('./capabilities');
const publicError = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode, connectionError: true });
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
        throw publicError('CONNECTION_INPUT_INVALID', '连接参数无效。');
}
function id(value) {
    if (typeof value !== 'string' || !UUID.test(value))
        throw publicError('CONNECTION_ID_INVALID', '连接标识无效。');
    return value;
}
function model(value, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value))
        throw publicError('CONNECTION_MODEL_INVALID', '模型名称无效，请保留完整型号。');
    return value;
}
function createConnectionService({ db, vault, fetchImpl = (...args) => fetch(...args), clock = () => Date.now(), checkTimeoutMs = 8000, cacheTtlMs = 300000 }) {
    const inFlight = new Map();
    const versionRow = versionId => db.prepare(`SELECT v.*,p.protocol,p.default_image_model,p.default_video_model FROM connection_versions v JOIN connection_preferences p ON p.connection_version_id=v.id WHERE v.id=?`).get(id(versionId));
    const connectionRow = connectionId => db.prepare('SELECT * FROM connections WHERE id=?').get(id(connectionId));
    const getVersion = versionId => {
        const row = versionRow(versionId);
        if (!row)
            throw publicError('CONNECTION_VERSION_NOT_FOUND', '找不到连接版本。', 404);
        return row;
    };
    const active = connectionId => {
        const row = connectionRow(connectionId);
        if (!row)
            throw publicError('CONNECTION_NOT_FOUND', '找不到连接。', 404);
        return row;
    };
    const currentId = () => db.prepare('SELECT connection_id FROM connection_defaults WHERE singleton=1').get()?.connection_id;
    function summary(connectionId) {
        const connection = active(connectionId), version = getVersion(connection.current_version_id);
        const check = db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(version.id);
        const credentialState = vault.state(version.credential_ref);
        return { connectionId: connection.id, connectionVersionId: version.id, displayName: connection.display_name, baseUrl: version.base_url, provider: version.provider, protocol: version.protocol,
            hasCredential: credentialState !== 'missing', credentialState, validationState: check?.validation_state || 'unverified', lastCheckedAt: check?.last_checked_at || null, lastSuccessAt: check?.last_success_at || null, modelsFetchedAt: check?.models_fetched_at || null, errorCode: check?.error_code || null,
            defaultImageModel: version.default_image_model, defaultVideoModel: version.default_video_model, isDefault: currentId() === connectionId };
    }
    function save(input) {
        exact(input, ['connectionId', 'expectedVersionId', 'displayName', 'baseUrl', 'provider', 'apiKey', 'defaultImageModel', 'defaultVideoModel']);
        const connectionId = input.connectionId ? id(input.connectionId) : randomUUID();
        const previous = input.connectionId ? active(connectionId) : null;
        if (previous && input.expectedVersionId !== previous.current_version_id)
            throw publicError('CONNECTION_VERSION_CONFLICT', '连接已更新，请重新读取后保存。', 409);
        if (!previous && input.expectedVersionId !== undefined)
            throw publicError('CONNECTION_INPUT_INVALID', '新连接不能指定旧版本。');
        const old = previous ? getVersion(previous.current_version_id) : null;
        const baseUrl = normalizeBaseUrl(input.baseUrl === undefined ? (old?.base_url || OPENSOSEN_URL) : input.baseUrl);
        const provider = input.provider === undefined ? (old?.provider || (baseUrl === OPENSOSEN_URL ? 'opensosen' : 'openai-compatible')) : input.provider;
        if (!['opensosen', 'openai-compatible'].includes(provider))
            throw publicError('CONNECTION_PROVIDER_INVALID', '服务预设无效。');
        const displayName = input.displayName === undefined ? (previous?.display_name || 'OpenSosen') : input.displayName;
        if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100 || /\p{Cc}/u.test(displayName))
            throw publicError('CONNECTION_INPUT_INVALID', '连接名称无效。');
        if (old && old.base_url !== baseUrl && input.apiKey === undefined && old.credential_ref)
            throw publicError('CREDENTIAL_REQUIRED', '修改服务地址时请重新输入凭据，避免向其他服务发送旧凭据。', 409);
        const image = model(input.defaultImageModel, old?.default_image_model || PRESET_MODELS[0]);
        const video = model(input.defaultVideoModel, old?.default_video_model || PRESET_MODELS[2]);
        if (input.apiKey && [displayName, baseUrl, image, video].some(value => value.includes(input.apiKey)))
            throw publicError('CONNECTION_INPUT_INVALID', '凭据不能出现在连接名称、地址或模型中。');
        return db.transaction(() => {
            const now = new Date(clock()).toISOString(), versionId = randomUUID();
            const credentialRef = input.apiKey === undefined ? (old?.credential_ref || null) : vault.store(input.apiKey);
            if (!previous)
                db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(connectionId, displayName, now, now);
            db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,credential_ref,created_at) VALUES(?,?,?,?,?,?)').run(versionId, connectionId, baseUrl, provider, credentialRef, now);
            db.prepare('INSERT INTO connection_preferences VALUES(?,?,?,?)').run(versionId, 'openai', image, video);
            db.prepare('UPDATE connections SET display_name=?,current_version_id=?,updated_at=? WHERE id=?').run(displayName, versionId, now, connectionId);
            if (!currentId())
                db.prepare('INSERT INTO connection_defaults VALUES(1,?)').run(connectionId);
            seedCapabilities(db, provider, baseUrl);
            return summary(connectionId);
        })();
    }
    function clear(input) {
        exact(input, ['connectionId', 'expectedVersionId']);
        const connection = active(input.connectionId);
        if (input.expectedVersionId !== connection.current_version_id)
            throw publicError('CONNECTION_VERSION_CONFLICT', '连接已更新，请重新读取后清除。', 409);
        return db.transaction(() => {
            vault.revokeConnection(connection.id);
            const old = getVersion(connection.current_version_id), versionId = randomUUID(), now = new Date(clock()).toISOString();
            db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,credential_ref,created_at) VALUES(?,?,?,?,NULL,?)').run(versionId, connection.id, old.base_url, old.provider, now);
            db.prepare('INSERT INTO connection_preferences VALUES(?,?,?,?)').run(versionId, old.protocol, old.default_image_model, old.default_video_model);
            db.prepare('UPDATE connections SET current_version_id=?,updated_at=? WHERE id=?').run(versionId, now, connection.id);
            return summary(connection.id);
        })();
    }
    function select(input) {
        exact(input, ['connectionId', 'expectedVersionId']);
        const connection = active(input.connectionId);
        if (input.expectedVersionId !== connection.current_version_id)
            throw publicError('CONNECTION_VERSION_CONFLICT', '连接已更新，请重新读取。', 409);
        db.prepare('INSERT INTO connection_defaults VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET connection_id=excluded.connection_id').run(connection.id);
        return summary(connection.id);
    }
    function getAuth(versionId) {
        const version = getVersion(versionId);
        return { connectionVersionId: version.id, baseUrl: version.base_url, provider: version.provider, protocol: version.protocol, apiKey: vault.read(version.credential_ref) };
    }
    function models(connectionId) {
        const connection = active(connectionId), version = getVersion(connection.current_version_id);
        const check = db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(version.id);
        const visible = check?.models_fetched_at ? JSON.parse(check.models_json) : null;
        const ids = [...new Set([...PRESET_MODELS, ...(visible || [])])];
        return { connectionVersionId: version.id, modelsFetchedAt: check?.models_fetched_at || null, models: ids.map(modelId => ({ model: modelId, visibility: visible ? (visible.includes(modelId) ? 'visible' : 'absent') : 'unknown' })), capabilities: listCapabilities(db, version.provider, version.base_url) };
    }
    async function checkConnection(connectionId, input = {}) {
        exact(input, ['connectionVersionId', 'force']);
        const connection = active(connectionId), versionId = connection.current_version_id;
        if (input.connectionVersionId !== versionId)
            throw publicError('CONNECTION_VERSION_CONFLICT', '连接已更新，请重新检查。', 409);
        if (input.force !== undefined && typeof input.force !== 'boolean')
            throw publicError('CONNECTION_INPUT_INVALID', '检查参数无效。');
        const old = db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(versionId);
        if (!input.force && old?.last_checked_at && clock() - Date.parse(old.last_checked_at) < cacheTtlMs)
            return { stale: false, cached: true, connection: summary(connectionId), ...models(connectionId) };
        if (inFlight.has(versionId))
            return inFlight.get(versionId);
        const pending = (async () => {
            let state = 'offline', errorCode = 'CONNECTION_OFFLINE', visible = null;
            try {
                const auth = getAuth(versionId);
                const response = await fetchImpl(auth.baseUrl + '/models', { method: 'GET', headers: { Authorization: 'Bearer ' + auth.apiKey, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(checkTimeoutMs) });
                if (response.status >= 300 && response.status < 400) {
                    state = 'redirect_rejected';
                    errorCode = 'CONNECTION_REDIRECT_REJECTED';
                    await response.body?.cancel();
                }
                else if ([401, 403].includes(response.status)) {
                    state = 'auth_rejected';
                    errorCode = 'AUTH_REJECTED';
                    await response.body?.cancel();
                }
                else if ([404, 405, 501].includes(response.status)) {
                    state = 'models_unsupported';
                    errorCode = 'MODEL_LIST_UNSUPPORTED';
                    await response.body?.cancel();
                }
                else if (!response.ok) {
                    state = 'unavailable';
                    errorCode = 'CONNECTION_UNAVAILABLE';
                    await response.body?.cancel();
                }
                else {
                    let size = 0;
                    const chunks = [];
                    for await (const chunk of response.body) {
                        size += chunk.length;
                        if (size > 1024 * 1024)
                            throw publicError('MODEL_LIST_INVALID', '模型列表过大。');
                        chunks.push(Buffer.from(chunk));
                    }
                    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!Array.isArray(payload?.data) || payload.data.length > 5000)
                        throw publicError('MODEL_LIST_INVALID', '模型列表格式无效。');
                    visible = [...new Set(payload.data.map(item => item?.id).filter(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) && !value.includes(auth.apiKey)))];
                    state = 'verified';
                    errorCode = null;
                }
            }
            catch (error) {
                if (['CREDENTIAL_REQUIRED', 'CREDENTIAL_UNAVAILABLE'].includes(error.code)) {
                    state = error.code === 'CREDENTIAL_REQUIRED' ? 'unconfigured' : 'credential_unavailable';
                    errorCode = error.code;
                }
                else if (error.code === 'MODEL_LIST_INVALID' || error instanceof SyntaxError) {
                    state = 'models_invalid';
                    errorCode = 'MODEL_LIST_INVALID';
                }
            }
            if (active(connectionId).current_version_id !== versionId)
                return { stale: true, cached: false, connectionVersionId: versionId };
            const now = new Date(clock()).toISOString();
            db.prepare(`INSERT INTO connection_checks(connection_version_id,validation_state,last_checked_at,last_success_at,models_fetched_at,models_json,error_code) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_version_id) DO UPDATE SET validation_state=excluded.validation_state,last_checked_at=excluded.last_checked_at,last_success_at=excluded.last_success_at,models_fetched_at=excluded.models_fetched_at,models_json=excluded.models_json,error_code=excluded.error_code`)
                .run(versionId, state, now, state === 'verified' ? now : (old?.last_success_at || null), visible ? now : (old?.models_fetched_at || null), visible ? JSON.stringify(visible) : (old?.models_json || '[]'), errorCode);
            return { stale: false, cached: false, connection: summary(connectionId), ...models(connectionId) };
        })();
        inFlight.set(versionId, pending);
        try {
            return await pending;
        }
        finally {
            inFlight.delete(versionId);
        }
    }
    return { save, clear, select, summary, list: () => db.prepare('SELECT id FROM connections ORDER BY created_at,id').all().map(row => summary(row.id)), current: () => currentId() ? summary(currentId()) : null, models, check: checkConnection, getAuth };
}
module.exports = { createConnectionService, publicError };
