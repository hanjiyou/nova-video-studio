'use strict';
const catalog = require('./model-catalog');
const routing = require('./route-policy');
const { IMAGE_MODEL, REFERENCE_GROUP, createImagePricing } = require('./image-pricing');
const credentialInModel=(name,key)=>Boolean(key&&(containsCredential(name,key)||name.includes(Buffer.from(key).toString('base64'))||name.includes(Buffer.from(key).toString('base64url'))));
const { createHash, randomUUID } = require('node:crypto');
const { UUID } = require('../storage/store');
const { containsCredential } = require('./redaction');
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
function createConnectionService({ db, vault, fetchImpl = (...args) => fetch(...args), clock = () => Date.now(), checkTimeoutMs = 8000, cacheTtlMs = 600000, failureBackoffMs = 30000 }) {
    // Existing saved connections receive additive evidence versions at startup, without saving credentials or rebinding tasks.
    db.transaction(() => { for (const scope of db.prepare('SELECT DISTINCT provider,base_url FROM connection_versions').all()) seedCapabilities(db, scope.provider, scope.base_url); })();
    const inFlight = new Map(), rejectionRefresh = new Map();
    const loadImagePricing = createImagePricing({ fetchImpl, timeoutMs: checkTimeoutMs });
    let candidate = null;
    function invalidateCandidate() { if (candidate) { candidate.controller.abort(); candidate = null; } }
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
    function getTransportRoute(versionId) {
        const version=getVersion(versionId);
        if(!routing.isBuiltin({provider:version.provider,baseUrl:version.base_url}))return null;
        const initialized=db.prepare("INSERT OR IGNORE INTO connection_routes VALUES(?,'cn',1)").run(version.connection_id).changes;
        if(initialized)db.prepare('DELETE FROM connection_checks WHERE connection_version_id IN (SELECT id FROM connection_versions WHERE connection_id=?)').run(version.connection_id);
        const row=db.prepare('SELECT route,revision FROM connection_routes WHERE connection_id=?').get(version.connection_id);
        return routing.snapshot(row);
    }
    const routeKey=value=>value?value.route+':'+value.revision:'custom';
    const sameRoute=(a,b)=>routeKey(a)===routeKey(b);
    const routeFields=versionId=>{const value=getTransportRoute(versionId);return {routeSupported:Boolean(value),route:value?.route||null,routeRevision:value?.revision||null};};
    const currentId = () => db.prepare('SELECT connection_id FROM connection_defaults WHERE singleton=1').get()?.connection_id;
    function summary(connectionId) {
        const connection = active(connectionId), version = getVersion(connection.current_version_id), route=routeFields(version.id);
        const check = db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(version.id);
        const credentialState = vault.state(version.credential_ref);
        return { ...route, connectionId: connection.id, connectionVersionId: version.id, displayName: connection.display_name, baseUrl: version.base_url, provider: version.provider, protocol: version.protocol,
            hasCredential: credentialState !== 'missing', credentialState, validationState: check?.validation_state || 'unverified', lastCheckedAt: check?.last_checked_at || null, lastSuccessAt: check?.last_success_at || null, modelsFetchedAt: check?.models_fetched_at || null, errorCode: check?.error_code || null,
            defaultImageModel: version.default_image_model, defaultVideoModel: version.default_video_model, isDefault: currentId() === connectionId };
    }
    async function pricing(connectionId, { force = false } = {}) {
        const connection = active(connectionId), versionId = connection.current_version_id;
        const selected = getTransportRoute(versionId);
        const value = selected ? await loadImagePricing(selected.route, { scope: versionId + ':' + routeKey(selected), force }) : { model: IMAGE_MODEL, group: REFERENCE_GROUP, estimate: null, reason: 'PRICING_UNSUPPORTED', cached: false };
        const stale = active(connectionId).current_version_id !== versionId || !sameRoute(selected, getTransportRoute(versionId));
        return { connectionVersionId: versionId, route: selected?.route || null, routeRevision: selected?.revision || null, ...value, stale, ...(stale ? { estimate: null } : {}) };
    }
    function prepare(input) {
        exact(input, ['connectionId', 'expectedVersionId', 'displayName', 'baseUrl', 'provider', 'apiKey', 'defaultImageModel', 'defaultVideoModel', 'route', 'expectedRouteRevision']);
        const connectionId = input.connectionId ? id(input.connectionId) : randomUUID();
        const previous = input.connectionId ? active(connectionId) : null;
        if (previous && input.expectedVersionId !== previous.current_version_id)
            throw publicError('CONNECTION_VERSION_CONFLICT', '连接已更新，请重新读取后保存。', 409);
        if (!previous && input.expectedVersionId !== undefined)
            throw publicError('CONNECTION_INPUT_INVALID', '新连接不能指定旧版本。');
        const old = previous ? getVersion(previous.current_version_id) : null;
        const baseUrl = normalizeBaseUrl(input.baseUrl === undefined ? (old?.base_url || OPENSOSEN_URL) : input.baseUrl);
        const provider = input.provider === undefined ? (old?.provider || (Object.values(routing.BASES).includes(baseUrl) ? 'opensosen' : 'openai-compatible')) : input.provider;
        if (!['opensosen', 'openai-compatible'].includes(provider))
            throw publicError('CONNECTION_PROVIDER_INVALID', '服务预设无效。');
        const displayName = input.displayName === undefined ? (previous?.display_name || 'OpenSosen') : input.displayName;
        if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100 || /\p{Cc}/u.test(displayName))
            throw publicError('CONNECTION_INPUT_INVALID', '连接名称无效。');
        if (old && old.base_url !== baseUrl && input.apiKey === undefined && old.credential_ref)
            throw publicError('CREDENTIAL_REQUIRED', '修改服务地址时请重新输入凭据，避免向其他服务发送旧凭据。', 409);
        const image = model(input.defaultImageModel, old?.default_image_model || PRESET_MODELS[0]);
        const video = model(input.defaultVideoModel, old?.default_video_model || PRESET_MODELS[2]);
        if (input.apiKey && [displayName, baseUrl, image, video].some(value => containsCredential(value,input.apiKey)))
            throw publicError('CONNECTION_INPUT_INVALID', '凭据不能出现在连接名称、地址或模型中。');
        const supported=routing.isBuiltin({provider,baseUrl}), currentRoute=old?getTransportRoute(old.id):null;
        const storedRoute=currentRoute||(old?db.prepare('SELECT route,revision FROM connection_routes WHERE connection_id=?').get(connectionId):null);
        if(input.route!==undefined&&(!supported||!Object.hasOwn(routing.BASES,input.route)))throw publicError('TRANSPORT_ROUTE_INVALID','访问线路无效。');
        if(input.expectedRouteRevision!==undefined&&(!Number.isSafeInteger(input.expectedRouteRevision)||input.expectedRouteRevision<1))throw publicError('TRANSPORT_ROUTE_INVALID','线路版本无效。');
        if(previous&&input.route!==undefined&&input.expectedRouteRevision!==(storedRoute?.revision||1))throw publicError('CONNECTION_ROUTE_CONFLICT','访问线路已更新，请重新读取后保存。',409);
        const transportRoute=supported?{route:input.route??storedRoute?.route??'cn',revision:storedRoute?.revision||1}:null;
        return { connectionId, previous, old, baseUrl, provider, displayName, image, video, transportRoute, currentRoute, storedRoute };
    }
    function save(input) { invalidateCandidate(); return persist(input); }
    function persist(input) {
        const { connectionId, previous, old, baseUrl, provider, displayName, image, video, transportRoute, storedRoute } = prepare(input);
        return db.transaction(() => {
            const now = new Date(clock()).toISOString();
            const unchanged=old&&input.apiKey===undefined&&old.base_url===baseUrl&&old.provider===provider&&previous.display_name===displayName&&old.default_image_model===image&&old.default_video_model===video;
            const versionId = unchanged?old.id:randomUUID();
            const credentialRef = input.apiKey === undefined ? (old?.credential_ref || null) : vault.store(input.apiKey);
            if (!previous)
                db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(connectionId, displayName, now, now);
            if(!unchanged){db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,credential_ref,created_at) VALUES(?,?,?,?,?,?)').run(versionId, connectionId, baseUrl, provider, credentialRef, now);
            db.prepare('INSERT INTO connection_preferences VALUES(?,?,?,?)').run(versionId, 'openai', image, video);}
            db.prepare('UPDATE connections SET display_name=?,current_version_id=?,updated_at=? WHERE id=?').run(displayName, versionId, now, connectionId);
            if (!currentId())
                db.prepare('INSERT INTO connection_defaults VALUES(1,?)').run(connectionId);
            if(transportRoute){
                const changed=storedRoute&&storedRoute.route!==transportRoute.route;
                db.prepare('INSERT INTO connection_routes VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET route=excluded.route,revision=excluded.revision').run(connectionId,transportRoute.route,transportRoute.revision+(changed?1:0));
                if(changed){db.prepare('DELETE FROM connection_checks WHERE connection_version_id IN (SELECT id FROM connection_versions WHERE connection_id=?)').run(connectionId);diagnostic('route_changed','saved',{operation:'settings',route:transportRoute.route,routeRevision:transportRoute.revision+1,previousRoute:storedRoute.route,previousRouteRevision:storedRoute.revision});}
            }
            seedCapabilities(db, provider, baseUrl);
            return summary(connectionId);
        })();
    }
    function clear(input) {
        invalidateCandidate();
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
        invalidateCandidate();
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
    function settingsKey(version) {
        return 'model-settings:' + createHash('sha256').update(JSON.stringify([version.connection_id,version.provider,version.base_url,version.credential_ref])).digest('hex');
    }
    function preferences(version) { const row=db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(settingsKey(version)); return row?JSON.parse(row.value_json):{}; }
    function writeSetting(key,value) { db.prepare('INSERT INTO app_settings VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=app_settings.revision+1,updated_at=excluded.updated_at').run(key,JSON.stringify(value),new Date(clock()).toISOString()); }
    function diagnostic(reason,result,extra={}) {
        try {const key='model-catalog-diagnostics',row=db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(key),events=row?JSON.parse(row.value_json):[];
        events.push({at:new Date(clock()).toISOString(),reason,result,...extra}); writeSetting(key,events.slice(-100));}catch{/* Diagnostics must not affect connection or task control. */}
    }
    function updateModelSettings(connectionId,input) {
        exact(input,['connectionVersionId','model','categories','custom','defaultSeconds']);
        const connection=active(connectionId),version=getVersion(connection.current_version_id);
        if(input.connectionVersionId!==version.id)throw publicError('CONNECTION_VERSION_CONFLICT','连接已更新，请重新读取。',409);
        const name=model(input.model); if(name && version.credential_ref && credentialInModel(name,vault.read(version.credential_ref)))throw publicError('CONNECTION_INPUT_INVALID','型号不能包含凭据。'); if(!name)throw publicError('CONNECTION_MODEL_INVALID','请输入完整型号。');
        if(input.categories!==undefined&&input.categories!==null&&(!Array.isArray(input.categories)||input.categories.length>2||input.categories.some(c=>!['image','video'].includes(c))))throw publicError('CONNECTION_INPUT_INVALID','分类无效。');
        if(input.custom!==undefined&&typeof input.custom!=='boolean')throw publicError('CONNECTION_INPUT_INVALID','型号设置无效。');
        const rule=catalog.videoRule(name,version);
        if(input.defaultSeconds!==undefined&&(!rule||!Number.isInteger(input.defaultSeconds)||input.defaultSeconds<rule.minSeconds||input.defaultSeconds>rule.maxSeconds))throw publicError('CONNECTION_INPUT_INVALID','默认秒数超出型号范围。');
        const saved=preferences(version),previous=saved[name]||{};
        if(!Object.hasOwn(saved,name)&&Object.keys(saved).length>=500)throw publicError('CONNECTION_INPUT_INVALID','手动型号设置过多。');
        saved[name]={...previous,...(input.categories!==undefined?{categories:input.categories===null?undefined:[...new Set(input.categories)]}:{}),...(input.custom!==undefined?{custom:input.custom}:{}),...(input.defaultSeconds!==undefined?{defaultSeconds:input.defaultSeconds}:{})};
        writeSetting(settingsKey(version),saved);diagnostic('settings','saved');return models(connectionId);
    }
    function models(connectionId) {
        const connection = active(connectionId), version = getVersion(connection.current_version_id), route=routeFields(version.id);
        const check = db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(version.id);
        const visible = check?.models_fetched_at ? catalog.entries(JSON.parse(check.models_json)) : null;
        const saved=preferences(version),history=db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(settingsKey(version)+':known');
        const known=history?JSON.parse(history.value_json):[];
        const capabilities=listCapabilities(db,version.provider,version.base_url);
        const ids = [...new Set([...PRESET_MODELS,version.default_image_model,version.default_video_model,...Object.keys(saved),...known,...(visible || []).map(item=>item.model)])];
        return { ...route, transportEvidence:getTransportRoute(version.id)?.route==='cn'?'generation_unverified':'see_capability_evidence', connectionVersionId: version.id, modelsFetchedAt: check?.models_fetched_at || null, refreshError:check?.error_code || null, modelSettings:saved,
            models: ids.map(modelId => {const item=visible?.find(item=>item.model===modelId),override=saved[modelId];return {model:modelId,endpointTypes:item?.endpointTypes || [],...catalog.classify(modelId,item?.endpointTypes,override?.categories),custom:override?.custom===true,visibility:visible?(item?'visible':'absent'):'unknown'};}), capabilities };
    }
    async function ensureModels(versionId) {
        const selected=getTransportRoute(versionId);
        const version=getVersion(versionId),connection=active(version.connection_id);
        if(connection.current_version_id!==versionId)throw publicError('CONNECTION_VERSION_CONFLICT','连接已更新，请重新提交。',409);
        await checkConnection(connection.id,{connectionVersionId:versionId,reason:'submit'});
        if(active(connection.id).current_version_id!==versionId||!sameRoute(selected,getTransportRoute(versionId)))throw publicError('CONNECTION_VERSION_CONFLICT','连接已更新，请重新提交。',409);
        const result=models(connection.id),check=db.prepare('SELECT validation_state FROM connection_checks WHERE connection_version_id=?').get(versionId);
        if(check?.validation_state==='auth_rejected')throw publicError('AUTH_REJECTED','当前连接鉴权被拒绝。',401);
        return result;
    }
    async function modelRejected(versionId,selected) {
        if(selected===undefined)selected=getTransportRoute(versionId);
        const version=getVersion(versionId);if(active(version.connection_id).current_version_id!==versionId)return;
        if(!sameRoute(selected??null,getTransportRoute(versionId)))return;
        const key=versionId+':'+routeKey(selected);if(rejectionRefresh.has(key)&&clock()-rejectionRefresh.get(key)<failureBackoffMs)return;
        rejectionRefresh.set(key,clock());
        return checkConnection(version.connection_id,{connectionVersionId:versionId,force:true,reason:'model_rejected'});
    }
    async function probeModels(getCredential, signal) {
            let state = 'offline', errorCode = 'CONNECTION_OFFLINE', visible = null, httpStatus = null;
            try {
                const auth = getCredential();
                const request=routing.resolveRequest(auth,{url:auth.baseUrl+'/models',method:'GET'},'models',auth.transportRoute);
                const response = await fetchImpl(request.url, { method: 'GET', headers: { Authorization: 'Bearer ' + auth.apiKey, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(checkTimeoutMs), ...(signal ? [signal] : [])]) });
                httpStatus = response.status;
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
                    if (!Array.isArray(payload?.data) || payload.data.length > 5000 || payload.data.some(item =>
                        !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !catalog.ID.test(item.id) ||
                        (item.supported_endpoint_types !== undefined && (!Array.isArray(item.supported_endpoint_types) || item.supported_endpoint_types.some(type => typeof type !== 'string')))))
                        throw publicError('MODEL_LIST_INVALID', '模型列表格式无效。');
                    visible = catalog.entries(payload.data).filter(item => !credentialInModel(item.model,auth.apiKey));
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
        return { state, errorCode, visible, httpStatus };
    }
    async function checkConnection(connectionId, input = {}) {
        exact(input, ['connectionVersionId', 'force', 'reason', 'expectedRouteRevision']);
        const reason=['startup','submit','manual','connection_changed','model_rejected'].includes(input.reason)?input.reason:'manual';
        const connection = active(connectionId), versionId = connection.current_version_id;
        if (input.connectionVersionId !== versionId)
            throw publicError('CONNECTION_VERSION_CONFLICT', '连接已更新，请重新检查。', 409);
        if (input.force !== undefined && typeof input.force !== 'boolean')
            throw publicError('CONNECTION_INPUT_INVALID', '检查参数无效。');
        const selected=getTransportRoute(versionId), flightKey=versionId+':'+routeKey(selected);
        if(input.expectedRouteRevision!==undefined&&input.expectedRouteRevision!==selected?.revision)throw publicError('CONNECTION_ROUTE_CONFLICT','访问线路已更新，请重新检查。',409);
        // A caller must observe an ongoing refresh rather than an older successful cache.
        if (inFlight.has(flightKey)) return inFlight.get(flightKey);
        const old = db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(versionId);
        const freshSuccess = !old?.error_code && old?.models_fetched_at && clock() - Date.parse(old.models_fetched_at) < cacheTtlMs;
        const backingOff = old?.error_code && clock() - Date.parse(old.last_checked_at) < failureBackoffMs;
        if ((!input.force && freshSuccess) || (reason !== 'manual' && backingOff))
            return { stale: false, cached: true, connection: summary(connectionId), ...models(connectionId) };
        const pending = (async () => {
            const [{ state, errorCode, visible }] = await Promise.all([
                probeModels(() => ({...getAuth(versionId),transportRoute:selected})),
                pricing(connectionId, { force: true }).catch(() => null),
            ]);
            if (active(connectionId).current_version_id !== versionId||!sameRoute(selected,getTransportRoute(versionId)))
                return { stale: true, cached: false, connectionVersionId: versionId };
            const now = new Date(clock()).toISOString();
            db.prepare(`INSERT INTO connection_checks(connection_version_id,validation_state,last_checked_at,last_success_at,models_fetched_at,models_json,error_code) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_version_id) DO UPDATE SET validation_state=excluded.validation_state,last_checked_at=excluded.last_checked_at,last_success_at=excluded.last_success_at,models_fetched_at=excluded.models_fetched_at,models_json=excluded.models_json,error_code=excluded.error_code`)
                .run(versionId, state, now, state === 'verified' ? now : (old?.last_success_at || null), visible ? now : (old?.models_fetched_at || null), visible ? JSON.stringify(visible) : (old?.models_json || '[]'), errorCode);
            if(visible){const version=getVersion(versionId),key=settingsKey(version)+':known',prior=db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(key);writeSetting(key,[...new Set([...(prior?JSON.parse(prior.value_json):[]),...catalog.entries(JSON.parse(old?.models_json||'[]')).map(item=>item.model),...visible.map(item=>item.model)])].slice(-5000));}
            const previousNames=new Set(catalog.entries(JSON.parse(old?.models_json||'[]')).map(item=>item.model)),nextNames=new Set((visible||[]).map(item=>item.model));
            diagnostic(reason,state,{operation:'models',route:selected?.route||null,routeRevision:selected?.revision||null,targetHost:selected?new URL(routing.BASES[selected.route]).hostname:null,count:visible?.length || 0,usingCache:!visible&&Boolean(old?.models_fetched_at),removedCount:visible?[...previousNames].filter(name=>!nextNames.has(name)).length:0,addedCount:visible?[...nextNames].filter(name=>!previousNames.has(name)).length:0,classificationCounts:visible?visible.reduce((counts,item)=>{const source=catalog.classify(item.model,item.endpointTypes).classificationSource;counts[source]=(counts[source]||0)+1;return counts;},{}):{}});
            return { stale: false, cached: false, connection: summary(connectionId), ...models(connectionId) };
        })();
        inFlight.set(flightKey, pending);
        try {
            return await pending;
        }
        finally {
            inFlight.delete(flightKey);
        }
    }
    function cancelCandidate(input) {
        exact(input, ['operationId']); id(input.operationId);
        if (candidate?.id === input.operationId) invalidateCandidate();
        return { cancelled: true };
    }
    async function validateAndSave(input, store) {
        exact(input, ['connectionId','expectedVersionId','displayName','baseUrl','provider','apiKey','defaultImageModel','defaultVideoModel','operationId','expectedOnboardingRevision','route','expectedRouteRevision']);
        const { operationId, expectedOnboardingRevision, ...fields } = input;
        id(operationId); invalidateCandidate();
        // Validate the same immutable field set used by persist, before any network call.
        const prepared = prepare(fields);
        const key = fields.apiKey === undefined ? vault.read(prepared.old?.credential_ref) : fields.apiKey;
        if (typeof key !== 'string' || !key || key.length > 4096 || key.trim() !== key || /\p{Cc}/u.test(key)) throw publicError('CREDENTIAL_REQUIRED','请填写有效的 API Key。');
        if ([prepared.displayName,prepared.baseUrl,prepared.image,prepared.video].some(value=>containsCredential(value,key))) throw publicError('CONNECTION_INPUT_INVALID','凭据不能出现在连接名称、地址或模型中。');
        if (expectedOnboardingRevision !== undefined && (!Number.isInteger(expectedOnboardingRevision) || expectedOnboardingRevision < 0 || !store)) throw publicError('CONNECTION_INPUT_INVALID','引导版本无效。');
        invalidateCandidate();
        const operation = { id: operationId, controller: new AbortController() }; candidate = operation;
        try {
            const unchangedSaved = prepared.previous && fields.apiKey === undefined &&
                prepared.old.base_url === prepared.baseUrl && prepared.old.provider === prepared.provider &&
                prepared.previous.display_name === prepared.displayName && prepared.old.default_image_model === prepared.image &&
                prepared.old.default_video_model === prepared.video && sameRoute(prepared.currentRoute, prepared.transportRoute);
            const [result] = await Promise.all([
                probeModels(() => ({ baseUrl: prepared.baseUrl,provider:prepared.provider,transportRoute:prepared.transportRoute, apiKey: key }), operation.controller.signal),
                unchangedSaved ? pricing(prepared.connectionId, { force: true }).catch(() => null) : Promise.resolve(null),
            ]);
            if (candidate !== operation || operation.controller.signal.aborted || prepared.previous&&(active(prepared.connectionId).current_version_id!==fields.expectedVersionId||!sameRoute(prepared.currentRoute,getTransportRoute(fields.expectedVersionId)))) return { stale: true, cancelled: true };
            if (result.state !== 'verified') {
                // An unchanged saved configuration may record its latest failure, while a
                // failed edited candidate never mutates the active profile or credential.
                let currentConnection;
                if (prepared.previous && fields.apiKey === undefined) {
                    const old=summary(prepared.connectionId);
                    if(old.connectionVersionId===fields.expectedVersionId&&old.baseUrl===prepared.baseUrl&&old.provider===prepared.provider&&old.displayName===prepared.displayName&&sameRoute(prepared.transportRoute,getTransportRoute(old.connectionVersionId))){
                        const check=db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(old.connectionVersionId),now=new Date(clock()).toISOString();
                        db.prepare('INSERT INTO connection_checks VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_version_id) DO UPDATE SET validation_state=excluded.validation_state,last_checked_at=excluded.last_checked_at,error_code=excluded.error_code')
                            .run(old.connectionVersionId,result.state,now,check?.last_success_at||null,check?.models_fetched_at||null,check?.models_json||'[]',result.errorCode);
                        currentConnection=summary(prepared.connectionId);
                    }
                }
                return { stale:false,validationState:result.state,errorCode:result.errorCode,httpStatus:result.httpStatus,...(currentConnection?{currentConnection}: {}) };
            }
            // No await between the host revision check and the transaction. Edits/cancel/new
            // operations invalidate this capability before it can create any persisted row.
            return db.transaction(() => {
                if (candidate !== operation || operation.controller.signal.aborted || prepared.previous&&(active(prepared.connectionId).current_version_id!==fields.expectedVersionId||!sameRoute(prepared.currentRoute,getTransportRoute(fields.expectedVersionId)))) return { stale: true, cancelled: true };
                const old = prepared.previous ? summary(prepared.connectionId) : null;
                const unchanged = old && fields.apiKey === undefined && old.baseUrl === prepared.baseUrl && old.provider === prepared.provider && old.displayName === prepared.displayName && old.defaultImageModel === prepared.image && old.defaultVideoModel === prepared.video;
                // Revalidate the current version even when reusing an unchanged saved connection.
                prepare(fields);
                const connection = unchanged&&sameRoute(prepared.transportRoute,getTransportRoute(old.connectionVersionId)) ? old : persist(fields), now = new Date(clock()).toISOString();
                db.prepare('INSERT INTO connection_checks(connection_version_id,validation_state,last_checked_at,last_success_at,models_fetched_at,models_json,error_code) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_version_id) DO UPDATE SET validation_state=excluded.validation_state,last_checked_at=excluded.last_checked_at,last_success_at=excluded.last_success_at,models_fetched_at=excluded.models_fetched_at,models_json=excluded.models_json,error_code=excluded.error_code')
                    .run(connection.connectionVersionId,'verified',now,now,now,JSON.stringify(result.visible),null);
                const onboarding = expectedOnboardingRevision === undefined ? undefined : store.putSetting('onboarding',{ value:{dismissed:false,step:'defaults'},expectedRevision:expectedOnboardingRevision });
                return { stale:false, connection:summary(connection.connectionId), ...models(connection.connectionId), ...(onboarding ? {onboarding} : {}) };
            })();
        } finally { if (candidate === operation) candidate = null; }
    }
    function completeSetup(input, store) {
        exact(input,['connectionId','expectedVersionId','defaultImageModel','defaultVideoModel','expectedOnboardingRevision']);
        if (!store) throw publicError('CONNECTION_SERVICE_NOT_READY','本机设置服务未就绪。');
        const {expectedOnboardingRevision,...fields}=input;
        const old=active(fields.connectionId);if(old.current_version_id!==fields.expectedVersionId)throw publicError('CONNECTION_VERSION_CONFLICT','连接已更新，请重新读取。',409);
        const previous=summary(fields.connectionId);prepare(fields);store.checkOutputDirectory();invalidateCandidate();
        return db.transaction(()=>{
            const unchanged=fields.defaultImageModel===previous.defaultImageModel&&fields.defaultVideoModel===previous.defaultVideoModel;
            const connection=unchanged?previous:persist(fields);
            // Only defaults changed: origin and credential are identical, so a prior read-only
            // check still describes this exact service. Tasks continue to reference old versions.
            if(!unchanged)db.prepare('INSERT INTO connection_checks SELECT ?,validation_state,last_checked_at,last_success_at,models_fetched_at,models_json,error_code FROM connection_checks WHERE connection_version_id=?').run(connection.connectionVersionId,previous.connectionVersionId);
            const onboarding=expectedOnboardingRevision===undefined?undefined:store.putSetting('onboarding',{value:{dismissed:true,step:'completed'},expectedRevision:expectedOnboardingRevision});
            return {connection:summary(connection.connectionId),...(onboarding?{onboarding}:{})};
        })();
    }
    return { save, clear, select, validateAndSave, cancelCandidate, completeSetup, summary, list: () => db.prepare('SELECT id FROM connections ORDER BY created_at,id').all().map(row => summary(row.id)), current: () => currentId() ? summary(currentId()) : null, models, pricing, updateModelSettings, ensureModels, modelRejected, check: checkConnection, getAuth, getTransportRoute };
}
module.exports = { createConnectionService, publicError };
