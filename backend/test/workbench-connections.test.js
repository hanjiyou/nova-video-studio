'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const { migrateDatabase, MIGRATIONS } = require('../storage/migrations');
const { createConnectionService } = require('../connections/service');
const { normalizeBaseUrl, PRESET_MODELS, OPENSOSEN_URL } = require('../connections/capabilities');
const { createCredentialVault } = require('../../desktop/credential-vault.cjs');
const { registerDesktopIpc } = require('../../desktop/ipc.cjs');
// Cryptographic fake for Node unit tests only; real Electron/Windows safeStorage is tested separately.
function protection() {
    const key = randomBytes(32);
    const value = { enabled: true, broken: false, backend: 'dpapi', isEncryptionAvailable() { return this.enabled; }, getSelectedStorageBackend() { return this.backend; },
        encryptString(text) { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), bytes]); },
        decryptString(bytes) {
            if (this.broken)
                throw new Error('synthetic decryption failure');
            const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
            cipher.setAuthTag(bytes.subarray(12, 28));
            return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
        } };
    return value;
}
async function setup(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-connections-'));
    const db = new Database(path.join(directory, 'tasks.sqlite'));
    await migrateDatabase({ db, dbPath: db.name });
    const safeStorage = protection(), vault = createCredentialVault({ db, safeStorage });
    // These cases assert the model protocol; public price requests have their own dedicated suite.
    const fetchImpl = options.fetchImpl ? async (url, init) => new URL(url).pathname === '/api/pricing'
        ? Response.json({ data: [] }) : options.fetchImpl(url, init) : undefined;
    const service = createConnectionService({ db, vault, ...options, ...(fetchImpl ? { fetchImpl } : {}) });
    t.after(() => {
        if (db.open)
            db.close();
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    return { db, directory, safeStorage, vault, service };
}
const fixtureKey = 'synthetic-vault-key-only-for-tests';
const save = service => service.save({ displayName: '共享图片视频连接', baseUrl: OPENSOSEN_URL, apiKey: fixtureKey });
const expectCode = (fn, code) => assert.throws(fn, error => error.code === code);
test('safeStorage vault persists ciphertext only; connection summary never exposes key/ciphertext/ref', async (t) => {
    const f = await setup(t), connection = save(f.service);
    assert.equal(connection.hasCredential, true);
    assert.equal(connection.credentialState, 'ready');
    assert.deepEqual([connection.defaultImageModel, connection.defaultVideoModel], [PRESET_MODELS[0], PRESET_MODELS[2]]);
    const row = f.db.prepare('SELECT * FROM credential_entries').get();
    assert.ok(Buffer.isBuffer(row.ciphertext));
    assert.equal(row.ciphertext.includes(Buffer.from(fixtureKey)), false);
    assert.equal(f.vault.read(row.id), fixtureKey);
    const dto = JSON.stringify({ list: f.service.list(), models: f.service.models(connection.connectionId) });
    for (const secret of [fixtureKey, row.id, row.ciphertext.toString('base64')])
        assert.equal(dto.includes(secret), false);
    f.db.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(fs.readFileSync(f.db.name).includes(Buffer.from(fixtureKey)), false);
});
test('encryption unavailable/basic_text/encryption error fails closed without inserting plaintext or partial versions', async (t) => {
    const f = await setup(t);
    for (const state of ['disabled', 'basic_text', 'throw']) {
        f.safeStorage.enabled = state !== 'disabled';
        f.safeStorage.backend = state === 'basic_text' ? 'basic_text' : 'dpapi';
        if (state === 'throw')
            f.safeStorage.encryptString = () => { throw new Error(fixtureKey); };
        expectCode(() => save(f.service), 'CREDENTIAL_UNAVAILABLE');
        for (const table of ['connections', 'connection_versions', 'credential_entries'])
            assert.equal(f.db.prepare('SELECT count(*) n FROM ' + table).get().n, 0);
    }
});
test('changing address/key creates immutable versions; old auth and defaults never follow current configuration', async (t) => {
    const f = await setup(t), first = save(f.service);
    const second = f.service.save({ connectionId: first.connectionId, expectedVersionId: first.connectionVersionId, baseUrl: 'https://other.invalid/api/v1/', apiKey: 'synthetic-new-key', defaultImageModel: 'exact-image-choice', defaultVideoModel: 'exact-video-choice' });
    assert.notEqual(first.connectionVersionId, second.connectionVersionId);
    assert.deepEqual(f.service.getAuth(first.connectionVersionId), { connectionVersionId: first.connectionVersionId, baseUrl: OPENSOSEN_URL, provider: 'opensosen', protocol: 'openai', apiKey: fixtureKey });
    assert.equal(f.service.getAuth(second.connectionVersionId).baseUrl, 'https://other.invalid/api/v1');
    assert.equal(f.service.getAuth(second.connectionVersionId).apiKey, 'synthetic-new-key');
    assert.equal(first.defaultImageModel, PRESET_MODELS[0]);
    assert.equal(second.defaultImageModel, 'exact-image-choice');
    assert.throws(() => f.db.prepare('UPDATE connection_versions SET base_url=? WHERE id=?').run('https://forged.invalid', first.connectionVersionId), /IMMUTABLE/);
    assert.throws(() => f.db.prepare('UPDATE connection_preferences SET default_image_model=? WHERE connection_version_id=?').run('forged', first.connectionVersionId), /IMMUTABLE/);
    expectCode(() => f.service.save({ connectionId: first.connectionId, expectedVersionId: first.connectionVersionId, apiKey: 'stale' }), 'CONNECTION_VERSION_CONFLICT');
});
test('a new destination requires explicit credential input; keeping a versioned credential at the same address is allowed', async (t) => {
    const f = await setup(t), first = save(f.service);
    expectCode(() => f.service.save({ connectionId: first.connectionId, expectedVersionId: first.connectionVersionId, baseUrl: 'https://other.invalid' }), 'CREDENTIAL_REQUIRED');
    const second = f.service.save({ connectionId: first.connectionId, expectedVersionId: first.connectionVersionId, displayName: '仅修改显示名称' });
    assert.equal(f.service.getAuth(second.connectionVersionId).apiKey, fixtureKey);
});
test('clear revokes every version of a connection while preserving versions/tasks/assets and other connections', async (t) => {
    const f = await setup(t), first = save(f.service);
    const second = f.service.save({ connectionId: first.connectionId, expectedVersionId: first.connectionVersionId, apiKey: 'synthetic-new-key' });
    const other = f.service.save({ baseUrl: OPENSOSEN_URL, apiKey: 'other-synthetic-key' });
    const cleared = f.service.clear({ connectionId: first.connectionId, expectedVersionId: second.connectionVersionId });
    assert.equal(cleared.hasCredential, false);
    assert.equal(cleared.credentialState, 'missing');
    expectCode(() => f.service.getAuth(first.connectionVersionId), 'CREDENTIAL_REQUIRED');
    expectCode(() => f.service.getAuth(second.connectionVersionId), 'CREDENTIAL_REQUIRED');
    assert.equal(f.service.getAuth(other.connectionVersionId).apiKey, 'other-synthetic-key');
    assert.equal(f.db.prepare('SELECT count(*) n FROM connection_versions WHERE connection_id=?').get(first.connectionId).n, 3);
    assert.equal(f.db.prepare('SELECT count(*) n FROM credential_entries WHERE ciphertext IS NULL').get().n, 2);
    assert.equal(f.service.current().connectionId, first.connectionId);
    f.service.select({ connectionId: other.connectionId, expectedVersionId: other.connectionVersionId });
    assert.equal(f.service.current().connectionId, other.connectionId);
});
test('decryption failure is explicit and recoverable by new version; no replacement fallback for old task auth', async (t) => {
    const f = await setup(t), first = save(f.service);
    f.safeStorage.broken = true;
    assert.equal(f.service.summary(first.connectionId).credentialState, 'unavailable');
    expectCode(() => f.service.getAuth(first.connectionVersionId), 'CREDENTIAL_UNAVAILABLE');
    const second = f.service.save({ connectionId: first.connectionId, expectedVersionId: first.connectionVersionId, apiKey: 'new-synthetic-credential' });
    assert.notEqual(first.connectionVersionId, second.connectionVersionId);
    f.safeStorage.broken = false;
    assert.equal(f.service.getAuth(second.connectionVersionId).apiKey, 'new-synthetic-credential');
});
test('base URL normalization handles pasted endpoints and rejects embedded credentials/query/fragment/protocol tricks', () => {
    for (const url of [' https://newapi.opensosen.com/v1/ ', 'https://newapi.opensosen.com/v1/models', 'https://newapi.opensosen.com/v1/images/generations', 'https://newapi.opensosen.com/v1/videos', 'https://newapi.opensosen.com'])
        assert.equal(normalizeBaseUrl(url), OPENSOSEN_URL);
    for (const url of ['file:///etc/passwd', 'https://user:secret@example.invalid/v1', 'https://example.invalid/v1?apiKey=secret', 'https://example.invalid/v1#secret', 'https://example.invalid/a%2fb', 'https://example.invalid/with\\slash', 'not-url'])
        expectCode(() => normalizeBaseUrl(url), 'CONNECTION_URL_INVALID');
    assert.equal(normalizeBaseUrl('https://EXAMPLE.invalid/custom/v1/'), 'https://example.invalid/custom/v1');
});
test('read-only check uses only GET /models, no text-model requirement; caches visibility separately from capabilities', async (t) => {
    const calls = [];
    const f = await setup(t, { fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ data: PRESET_MODELS.map(id => ({ id })) }); } }), connection = save(f.service);
    const checked = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId });
    assert.equal(checked.connection.validationState, 'verified');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://newapi.opensosen.cn/v1/models');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + fixtureKey);
    assert.ok(PRESET_MODELS.every(id => checked.models.find(model => model.model === id)?.visibility === 'visible'));
    assert.equal(checked.models.find(model => model.model === 'gpt-image-2.5-sunburst').visibility, 'absent', 'configured image choices do not invent upstream availability');
    assert.equal(checked.capabilities.filter(cap => cap.evidenceLevel === 'historically_verified').length, 2);
    assert.ok(checked.capabilities.filter(cap => cap.evidenceVersion === 'opensosen-evidence-v1' && (cap.mode.endsWith('.text') || cap.model === PRESET_MODELS[0])).every(cap => cap.evidenceLevel === 'unverified'));
    const cached = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId });
    assert.equal(cached.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(checked).includes(fixtureKey), false);
});
test('model absence preserves exact selected defaults; unknown visible IDs do not manufacture capabilities or upgrade evidence', async (t) => {
    const f = await setup(t, { fetchImpl: async () => Response.json({ data: [{ id: 'other-visible-model' }, { id: fixtureKey }] }) }), connection = save(f.service);
    const checked = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId });
    assert.ok(checked.models.find(model => model.model === PRESET_MODELS[0]).visibility === 'absent');
    assert.equal(checked.connection.defaultImageModel, PRESET_MODELS[0]);
    assert.ok(checked.models.some(model => model.model === 'other-visible-model'));
    assert.equal(checked.capabilities.some(cap => cap.model === 'other-visible-model'), false);
    assert.equal(JSON.stringify(checked).includes(fixtureKey), false);
});
test('historical capability evidence is source/model/mode/parameters scoped and immutable', async (t) => {
    const f = await setup(t), first = save(f.service);
    const caps = f.service.models(first.connectionId).capabilities, historical = caps.filter(cap => cap.evidenceLevel === 'historically_verified');
    assert.equal(historical.length, 2);
    assert.deepEqual(historical.map(cap => cap.parameters.referenceCount).sort(), [1, 2]);
    assert.ok(historical.every(cap => cap.parameters.seconds === 6 && cap.parameters.size === '1280x720' && cap.parameters.inputReferenceName === 'input_reference' && !cap.evidence.applicationVerified));
    const other = f.service.save({ baseUrl: 'https://other.invalid/v1', provider: 'opensosen', apiKey: fixtureKey });
    assert.ok(f.service.models(other.connectionId).capabilities.every(cap => cap.evidenceLevel === 'unverified'));
    assert.throws(() => f.db.prepare("UPDATE model_capabilities SET evidence_level='verified' WHERE id=?").run(caps[0].capabilityVersionId), /IMMUTABLE/);
});
test('in-flight model check is deduplicated and stale result cannot overwrite a new configuration', async (t) => {
    let finish, calls = 0;
    const f = await setup(t, { fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }), connection = save(f.service);
    const request = { connectionVersionId: connection.connectionVersionId, force: true }, a = f.service.check(connection.connectionId, request), b = f.service.check(connection.connectionId, request);
    const next = f.service.save({ connectionId: connection.connectionId, expectedVersionId: connection.connectionVersionId, apiKey: 'updated-test-key' });
    finish(Response.json({ data: [{ id: 'stale-model' }] }));
    assert.equal((await a).stale, true);
    assert.equal((await b).stale, true);
    assert.equal(calls, 1);
    assert.equal(f.service.summary(connection.connectionId).connectionVersionId, next.connectionVersionId);
    assert.equal(f.service.summary(connection.connectionId).validationState, 'unverified');
    assert.equal(f.db.prepare('SELECT count(*) n FROM connection_checks').get().n, 0);
});
for (const [status, state, code] of [[401, 'auth_rejected', 'AUTH_REJECTED'], [403, 'auth_rejected', 'AUTH_REJECTED'], [404, 'models_unsupported', 'MODEL_LIST_UNSUPPORTED'], [405, 'models_unsupported', 'MODEL_LIST_UNSUPPORTED'], [503, 'unavailable', 'CONNECTION_UNAVAILABLE'], [302, 'redirect_rejected', 'CONNECTION_REDIRECT_REJECTED']])
    test('model check classifies HTTP ' + status + ' without exposing upstream errors or forwarding redirects', async (t) => {
        let calls = 0;
        const f = await setup(t, { fetchImpl: async () => { calls++; return new Response(fixtureKey, { status, headers: { Location: 'https://foreign.invalid' } }); } }), connection = save(f.service);
        const checked = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId });
        assert.equal(checked.connection.validationState, state);
        assert.equal(checked.connection.errorCode, code);
        assert.equal(calls, 1);
        assert.equal(JSON.stringify(checked).includes(fixtureKey), false);
    });
test('model response validation and network/decryption errors remain distinct without raw error leakage', async (t) => {
    let response = 'invalid';
    const f = await setup(t, { fetchImpl: async () => {
            if (response === 'network')
                throw new Error(fixtureKey);
            return new Response(response, { status: 200 });
        } }), connection = save(f.service);
    let checked = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId, force: true });
    assert.equal(checked.connection.errorCode, 'MODEL_LIST_INVALID');
    response = 'network';
    checked = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId, force: true });
    assert.equal(checked.connection.errorCode, 'CONNECTION_OFFLINE');
    f.safeStorage.broken = true;
    checked = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId, force: true });
    assert.equal(checked.connection.errorCode, 'CREDENTIAL_UNAVAILABLE');
    assert.equal(JSON.stringify(checked).includes(fixtureKey), false);
});
test('credential IPC validates actual sender and exact argument shape before invoking the vault', async (t) => {
    const f = await setup(t), handlers = new Map();
    let saves = 0;
    const ipc = registerDesktopIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }, dialog: {}, getWindow: () => null, policy: { isTrustedSender: event => event.trusted }, runtimeInfo: () => ({}), getConnectionService: () => ({ ...f.service, save(input) { saves++; return f.service.save(input); } }) });
    const handler = handlers.get('nova:save-connection'), input = { baseUrl: OPENSOSEN_URL, apiKey: fixtureKey };
    assert.equal((await handler({ trusted: false }, input)).code, 'IPC_FORBIDDEN');
    assert.equal(saves, 0);
    assert.equal((await handler({ trusted: true }, input, 'extra')).code, 'INVALID_ARGUMENT');
    assert.equal(saves, 0);
    assert.equal((await handler({ trusted: true }, { ...input, path: 'C:/arbitrary' })).code, 'CONNECTION_INPUT_INVALID');
    const result = await handler({ trusted: true }, input);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(fixtureKey), false);
    ipc.dispose();
    assert.equal(handlers.size, 0);
});
test('v3 additive upgrade preserves v2 history and creates a consistent pre-v3 backup exactly once', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-connections-upgrade-')), dbPath = path.join(directory, 'tasks.sqlite'), db = new Database(dbPath);
    t.after(() => { db.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    await migrateDatabase({ db, dbPath, migrations: MIGRATIONS.slice(0, 2) });
    const old = db.prepare('SELECT version,checksum FROM schema_migrations').all();
    const upgrade = await migrateDatabase({ db, dbPath, migrations:MIGRATIONS.slice(0,3) });
    assert.deepEqual(upgrade.applied, [3]);
    assert.deepEqual(db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=2').all(), old);
    const backup = new Database(upgrade.backupFile, { readonly: true });
    assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_entries'").get(), undefined);
    assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
    backup.close();
    assert.deepEqual((await migrateDatabase({ db, dbPath, migrations:MIGRATIONS.slice(0,3) })).applied, []);
});
test('version-bound legacy plugin uses exact original host, one /v1 suffix and manual redirects for submit/poll', async (t) => {
    const executor = require('../plugin-runtime/executor');
    const plugin = require('../plugin-runtime/registry').getPlugin('ccode-h3');
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return Response.json(init.method === 'POST' ? { id: 'synthetic-upstream', status: 'queued' } : { status: 'in_progress' }); });
    const context = executor.buildContext({ plugin, baseUrl: 'https://pro.ccode.vip/v1', apiKey: fixtureKey, connectionVersionId: 'synthetic-bound-version', model: 'fixture', fields: { prompt: '中文\n原文', seconds: 6 }, facets: { resolution: '2K' }, upstreamTaskId: 'synthetic-upstream' });
    assert.equal((await executor.submitTask(plugin, context)).upstreamTaskId, 'synthetic-upstream');
    await executor.pollTask(plugin, context);
    assert.deepEqual(calls.map(call => call.url), ['https://pro.ccode.vip/v1/videos', 'https://pro.ccode.vip/v1/videos/synthetic-upstream']);
    assert.ok(calls.every(call => call.init.headers.Authorization === 'Bearer ' + fixtureKey && call.init.redirect === 'manual'));
});
test('version-bound plugin cannot send credentials to another manifest-allowed origin or in an encoded URL', async (t) => {
    const executor = require('../plugin-runtime/executor');
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ id: 'synthetic' }); });
    const plugin = { id: 'fixture', allowedHosts: new Set(['original.invalid', 'other.invalid']), manifest: { credential: { defaultBaseUrl: 'https://original.invalid/v1' }, permissions: { hosts: ['original.invalid', 'other.invalid'] } }, driver: { buildSubmit: () => ({ url: 'https://other.invalid/v1/videos', method: 'POST', headers: { Authorization: 'Bearer ' + fixtureKey } }), buildQuery: () => ({ url: 'https://other.invalid/v1/videos/synthetic' }) } };
    const context = executor.buildContext({ plugin, baseUrl: 'https://original.invalid/v1', apiKey: fixtureKey, connectionVersionId: 'synthetic-bound-version', upstreamTaskId: 'synthetic' });
    await assert.rejects(executor.submitTask(plugin, context), /只能发送/);
    await assert.rejects(executor.pollTask(plugin, context), /只能发送/);
    plugin.driver.buildSubmit = () => ({ url: 'https://original.invalid/v1/videos?token=' + encodeURIComponent(fixtureKey) });
    await assert.rejects(executor.submitTask(plugin, context), error => !error.message.includes(fixtureKey) && /只能发送/.test(error.message));
    assert.equal(requests, 0);
});
test('check cache expires and transient failure preserves prior model timestamps without claiming current availability', async (t) => {
    let now = Date.now(), calls = 0, fail = false;
    const f = await setup(t, { clock: () => now, cacheTtlMs: 100, fetchImpl: async () => {
            calls++;
            if (fail)
                throw new Error('offline');
            return Response.json({ data: [{ id: PRESET_MODELS[0] }] });
        } }), connection = save(f.service);
    const first = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId });
    now += 50;
    assert.equal((await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId })).cached, true);
    assert.equal(calls, 1);
    now += 51;
    fail = true;
    const failed = await f.service.check(connection.connectionId, { connectionVersionId: connection.connectionVersionId });
    assert.equal(calls, 2);
    assert.equal(failed.connection.validationState, 'offline');
    assert.equal(failed.connection.lastSuccessAt, first.connection.lastSuccessAt);
    assert.equal(failed.connection.modelsFetchedAt, first.connection.modelsFetchedAt);
    assert.equal(failed.models.find(model => model.model === PRESET_MODELS[0]).visibility, 'visible');
});
test('bound declarative and driver responses cannot echo credentials into task IDs, errors or result assets', async (t) => {
    const executor = require('../plugin-runtime/executor');
    t.mock.method(globalThis, 'fetch', async () => Response.json({ id: fixtureKey, status: 'completed', video_url: 'https://cdn.invalid/' + encodeURIComponent(fixtureKey) }));
    const original = require('../plugin-runtime/registry').getPlugin('ccode-h3');
    for (const driver of [false, true]) {
        const plugin = driver ? { ...original, driver: { buildSubmit: () => ({ url: 'https://pro.ccode.vip/v1/videos', method: 'POST' }), buildQuery: () => ({ url: 'https://pro.ccode.vip/v1/videos/synthetic', method: 'GET' }) } } : original;
        const context = executor.buildContext({ plugin, baseUrl: 'https://pro.ccode.vip/v1', apiKey: fixtureKey, connectionVersionId: 'synthetic-bound-version', upstreamTaskId: 'synthetic', fields: { seconds: 6, prompt: 'synthetic' }, facets: { resolution: '2K' } });
        for (const method of ['submitTask', 'pollTask'])
            await assert.rejects(executor[method](plugin, context), error => !error.message.includes(fixtureKey) && /连接凭据/.test(error.message));
    }
});

test('known credential detection handles full/mixed/twice percent encoding and malformed neighbors while preserving unrelated errors', () => {
    const { containsCredential } = require('../connections/redaction');
    const key = 't04-é-密-A9';
    const encodeBytes = value => [...Buffer.from(value, 'utf8')].map(byte => '%' + byte.toString(16).padStart(2, '0')).join('');
    for (const echo of [key, encodeURIComponent(key), encodeBytes(key), encodeBytes(encodeBytes(key)), encodeBytes('t04-') + 'é-密-A9']) {
        for (const prefix of ['', 'invalid=%ZZ ', 'invalid=%FF%FE', '100% failed: '])
            assert.equal(containsCredential(prefix + echo, key), true, prefix + echo);
    }
    for (const message of ['ordinary upstream rejection', '100% capacity', '%ZZ%FF missing model', undefined, null])
        assert.equal(containsCredential(message, key), false);
    assert.equal(containsCredential(key, ''), false);
});
