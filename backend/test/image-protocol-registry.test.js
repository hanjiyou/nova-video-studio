'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../storage/migrations');
const { seedCapabilities, listCapabilities, generationEvidenceVerified } = require('../connections/capabilities');
const policy = require('../tasks/image-policy'), boundary = require('../tasks/workbench-input'), image = require('../tasks/flare-image-adapter');
const baseUrl = policy.POLICY.baseUrl, sunburst = 'gpt-image-2.5-sunburst';
const auth = { provider: policy.POLICY.provider, baseUrl, protocol: 'openai', apiKey: 'synthetic-configured-images-key', connectionVersionId: randomUUID() };
const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-v1/reference-a.png'));
const asset = { assetId: randomUUID(), kind: 'image', mimeType: 'image/png' };
function input(model = sunburst, mode = 'image.text', parameters = {}) {
    return { localRequestId: randomUUID(), connectionVersionId: auth.connectionVersionId, capabilityVersionId: randomUUID(),
        model, mode, prompt: '中文原文\n保留型号与原图', parameters, inputAssets: mode === 'image.reference' ? [{ assetId: asset.assetId, position: 0, role: 'reference' }] : [] };
}
async function database(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-configured-images-')), db = new Database(path.join(directory, 'tasks.sqlite'));
    await migrateDatabase({ db, dbPath: db.name });
    t.after(() => { db.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
    seedCapabilities(db, auth.provider, baseUrl); return db;
}

test('registered standard image models share an implemented protocol; a same-protocol model needs only a precise config entry', () => {
    assert.deepEqual(Object.keys(policy.POLICY.models), [policy.POLICY.model, sunburst]);
    for (const model of Object.keys(policy.POLICY.models)) {
        const rule = policy.imageRule(model, auth);
        assert.equal(rule.submissionEnabled, true); assert.equal(rule.profile, 'openai-images-v1');
        assert.deepEqual(rule.modes, ['image.text', 'image.reference']);
        assert.equal(policy.imageRule(model, { provider: auth.provider, base_url: baseUrl, protocol: 'openai' }).model, model);
    }
    for (const model of ['gpt-image-unknown', 'toString', '__proto__', [sunburst], null, 42]) assert.equal(policy.imageRule(model, auth), null);
    for (const change of [{ provider: 'openai-compatible' }, { baseUrl: 'https://other.invalid/v1' }, { protocol: 'arbitrary-api' }]) assert.equal(policy.imageRule(sunburst, { ...auth, ...change }), null);
    const added = 'gpt-image-synthetic-config-only';
    try {
        policy.POLICY.models[added] = { profile: 'openai-images-v1', submissionEnabled: true };
        const body = input(added), snapshot = boundary.snapshotFor(body, '1.1.0');
        assert.deepEqual(image.buildSubmit(snapshot, auth).json, { model: added, prompt: body.prompt, n: 1 });
        policy.POLICY.models[added] = { profile: 'openai-images-v1', submissionEnabled: true, modes: ['image.text'], sizes: ['1024x1024'], qualities: ['high'] };
        assert.equal(policy.validParameters({ quality: 'high' }, added, 'image.text'), true);
        assert.equal(policy.validParameters({ quality: 'max' }, added, 'image.text'), false);
        assert.throws(() => boundary.snapshotFor(input(added, 'image.reference'), '1.1.0'), { code: 'INPUT_INVALID' });
        policy.POLICY.models[added].modes = ['arbitrary.mode'];
        assert.equal(policy.imageRule(added), null);
        policy.POLICY.models[added].modes = ['image.text'];
        policy.POLICY.models[added].profile = 'unknown-protocol';
        assert.equal(policy.imageRule(added, auth), null);
        assert.throws(() => boundary.snapshotFor(body, '1.1.0'), { code: 'INPUT_INVALID' });
        assert.throws(() => image.buildSubmit(snapshot, auth), { code: 'INPUT_INVALID' });
    } finally { delete policy.POLICY.models[added]; }
});

test('both models receive immutable unverified configured capabilities, including automatic empty controls', async t => {
    const db = await database(t), before = db.prepare('SELECT * FROM model_capabilities ORDER BY id').all();
    seedCapabilities(db, auth.provider, baseUrl); assert.deepEqual(db.prepare('SELECT * FROM model_capabilities ORDER BY id').all(), before);
    const caps = listCapabilities(db, auth.provider, baseUrl);
    for (const model of Object.keys(policy.POLICY.models)) for (const mode of ['image.text', 'image.reference']) {
        const cap = caps.find(c => c.model === model && c.mode === mode && c.evidenceVersion === policy.POLICY.evidenceVersion);
        const snapshot = boundary.snapshotFor({ ...input(model, mode), capabilityVersionId: cap.capabilityVersionId }, '1.1.0');
        const row = boundary.validateCapability(db, snapshot, auth);
        assert.equal(policy.allowsNewSubmission(snapshot, auth), true);
        assert.equal(generationEvidenceVerified(row), false); assert.equal(cap.evidence.applicationVerified, false);
        assert.equal(cap.evidence.submissionEnabled, true); assert.deepEqual(cap.evidence.sourceIds, []);
        assert.equal(snapshot.model, model); assert.equal(snapshot.adapterId, 'opensosen-flare-image'); assert.equal(snapshot.adapterVersion, '1.1.0');
        assert.throws(() => boundary.validateCapability(db, { ...snapshot, model: model === sunburst ? policy.POLICY.model : sunburst }, auth), { code: 'CAPABILITY_UNVERIFIED' });
        for (const parameters of [{ n: 2 }, { quality: 'ultra' }, { size: 'auto' }, { endpoint: '/arbitrary' }]) assert.throws(() => boundary.snapshotFor({ ...input(model, mode), parameters }, '1.1.0'), { code: 'INPUT_INVALID' });
    }
    const current = caps.find(c => c.model === sunburst && c.mode === 'image.text' && c.isCurrent);
    assert.equal(current.evidenceVersion, policy.POLICY.evidenceVersion);
    for (const unknown of ['gpt-image-unregistered', [sunburst], null, 42]) assert.throws(() => boundary.snapshotFor(input(unknown), '1.1.0'), { code: 'INPUT_INVALID' });
});

test('disabling current submission rejects new intents while frozen capability validation and original requests stay recoverable', async t => {
    const db = await database(t), row = db.prepare('SELECT * FROM model_capabilities WHERE model=? AND mode=? AND evidence_version=?').get(sunburst, 'image.text', policy.POLICY.evidenceVersion);
    const snapshot = boundary.snapshotFor({ ...input(), capabilityVersionId: row.id }, '1.1.0');
    try {
        policy.POLICY.models[sunburst].submissionEnabled = false;
        assert.equal(policy.allowsNewSubmission(snapshot, auth), false);
        assert.equal(boundary.validateCapability(db, snapshot, auth).id, row.id);
        assert.equal(image.buildSubmit(snapshot, auth).json.model, sunburst);
    } finally { policy.POLICY.models[sunburst].submissionEnabled = true; }
});

test('legacy flare capability versions and 1.0 minimum snapshots keep their original identity and exact scope', async t => {
    const db = await database(t), row = db.prepare('SELECT * FROM model_capabilities WHERE model=? AND mode=? AND evidence_version=?').get(policy.POLICY.model, 'image.text', policy.POLICY.legacyEvidenceVersion);
    const original = { ...input(policy.POLICY.model, 'image.text', { quality: 'high' }), capabilityVersionId: row.id };
    const snapshot = boundary.snapshotFor(original, '1.1.0'), saved = JSON.stringify(snapshot);
    assert.equal(boundary.validateCapability(db, snapshot, auth).id, row.id);
    assert.equal(JSON.stringify(snapshot), saved); assert.equal(JSON.parse(row.evidence_json).applicationVerified, false);
    assert.throws(() => boundary.validateCapability(db, { ...snapshot, parameters: {} }, auth), { code: 'CAPABILITY_UNVERIFIED' });
    const minimum = { ...snapshot, adapterVersion: '1.0.0', parameters: {} };
    assert.deepEqual(image.buildSubmit(minimum, auth).json, { model: policy.POLICY.model, prompt: snapshot.prompt, n: 1 });
    assert.throws(() => image.buildSubmit({ ...minimum, model: sunburst }, auth), { code: 'INPUT_INVALID' });
});

test('both models use the frozen model for JSON and original single-image multipart over cn/com, with one authenticated POST each', async t => {
    const original = global.fetch, calls = [];
    global.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ data: [{ b64_json: bytes.toString('base64') }] }); };
    t.after(() => { global.fetch = original; });
    const adapter = image.createFlareImageAdapter({ validateCapability: () => {}, getAsset: () => asset, readAsset: () => ({ asset, bytes }) });
    for (const model of Object.keys(policy.POLICY.models)) for (const mode of ['image.text', 'image.reference']) for (const route of ['cn', 'com']) {
        const body = input(model, mode, { size: '1024x1536', quality: 'high' }), snapshot = boundary.snapshotFor(body, '1.1.0');
        const output = await adapter.submit({}, snapshot, { ...auth, transportRoute: { route, revision: 3 } });
        assert.equal(calls.length, 1 + Object.keys(policy.POLICY.models).indexOf(model) * 4 + ['image.text', 'image.reference'].indexOf(mode) * 2 + ['cn', 'com'].indexOf(route));
        const call = calls.at(-1);
        assert.equal(call.url, 'https://newapi.opensosen.' + route + '/v1/images/' + (mode === 'image.reference' ? 'edits' : 'generations'));
        assert.equal(call.init.method, 'POST'); assert.equal(call.init.headers.Authorization, 'Bearer ' + auth.apiKey);
        assert.deepEqual(output.resultSources[0].bytes, bytes);
        if (mode === 'image.text') assert.deepEqual(JSON.parse(call.init.body), { model, prompt: body.prompt, n: 1, size: '1024x1536', quality: 'high' });
        else {
            const wire = new Request(call.url, { ...call.init, duplex: 'half' }), form = await wire.formData();
            assert.equal(form.get('model'), model); assert.equal(form.get('size'), '1024x1536'); assert.equal(form.get('quality'), 'high');
            assert.equal(form.getAll('image').length, 1); assert.equal(form.get('image').type, 'image/png');
            assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), bytes);
        }
    }
    assert.equal(calls.length, 8);
});

test('sunburst failures never retry or change model, and shared URL/inline parsing never adds download credentials', async t => {
    const original = global.fetch, calls = [], snapshot = boundary.snapshotFor(input(), '1.1.0');
    let status = 503;
    global.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ error: { message: 'synthetic rejection' } }, { status }); };
    t.after(() => { global.fetch = original; });
    const adapter = image.createFlareImageAdapter({ validateCapability: () => {} });
    for (status of [400, 401, 403, 503]) {
        const before = calls.length;
        await assert.rejects(adapter.submit({}, snapshot, auth), error => error.httpStatus === status);
        assert.equal(calls.length, before + 1); assert.equal(JSON.parse(calls.at(-1).init.body).model, sunburst);
    }
    const result = image.parseSubmit({ data: [{ b64_json: bytes.toString('base64') }, { url: 'https://cdn.fixture.invalid/result.png?signature=synthetic' }] }, auth);
    assert.equal(result.resultSources[0].mimeType, 'image/png'); assert.equal(result.resultSources[1].authScope, 'none');
    assert.throws(() => image.parseSubmit({ data: [{ url: 'https://cdn.fixture.invalid/' + auth.apiKey }] }, auth), { code: 'RESPONSE_CREDENTIAL_REDACTED' });
    const count = calls.length;
    await assert.rejects(adapter.submit({}, { ...snapshot, model: 'arbitrary-image-model' }, auth), { code: 'INPUT_INVALID' });
    assert.equal(calls.length, count);
});
