'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto'), Database = require('better-sqlite3');
const { migrateDatabase } = require('../storage/migrations');
const { createConnectionService } = require('../connections/service');
const { IMAGE_MODEL, PRICING_GROUPS, parseImagePricing: parseRawImagePricing, createImagePricing } = require('../connections/image-pricing');
const { BASES } = require('../connections/route-policy');
const { start } = require('./support/desktop-http-runtime.cjs');
const REFERENCE_GROUP = PRICING_GROUPS[0];
const parseImagePricing = (payload, options = {}) => parseRawImagePricing(payload, { group: REFERENCE_GROUP, ...options });
function selectGroup(service, connection, pricingGroup = REFERENCE_GROUP) { const result = service.models(connection.connectionId), {revision,...value}=result.displaySettings; return service.updateModelDisplay(connection.connectionId,{connectionVersionId:result.connectionVersionId,expectedRouteRevision:result.routeRevision,expectedRevision:revision,...value,imageModels:[],videoModels:[],defaultImageModel:null,defaultVideoModel:null,pricingGroup}); }
const fixture = (price = 1) => ({
    success: true,
    data: [{ model_name: IMAGE_MODEL, quota_type: 1, model_price: price, billing_mode: 'tiered_expr', billing_expr: 'tier("image", fixed(' + price + ')) * image_count', enable_groups: ['high', 'super', REFERENCE_GROUP], secret: 'not-projected' }],
    group_ratio: { high: 0.4, super: 0.05, [REFERENCE_GROUP]: 0.12, unavailable: 0.001 },
});
const cleanup = directory => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
};
async function setup(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-reference-')), db = new Database(path.join(directory, 'tasks.sqlite'));
    await migrateDatabase({ db, dbPath: db.name });
    const { allowModelAuth = false, selectPricingGroup = true, ...serviceOptions } = options;
    const vault = { store: () => 'synthetic-reference', state: () => 'ready', read: () => {
        if (!allowModelAuth) throw Error('Pricing must never read a key');
        return 'synthetic-only-key';
    } };
    const service = createConnectionService({ db, vault, fetchImpl: async () => Response.json(fixture()), ...serviceOptions });
    const connection = service.save({ baseUrl: BASES.com, apiKey: 'synthetic-only-key' });
    if (selectPricingGroup) selectGroup(service, connection);
    t.after(() => { db.close(); cleanup(directory); });
    const switchRoute = route => { const old = service.summary(connection.connectionId); return service.save({ connectionId: old.connectionId, expectedVersionId: old.connectionVersionId, expectedRouteRevision: old.routeRevision, route }); };
    return { service, connection, db, switchRoute };
}

test('reference quote uses only the explicitly selected exact current group and multiplies the changing base price', () => {
    const value = parseImagePricing(fixture());
    assert.equal(value.group, '【生图分组】image2超分');
    assert.deepEqual(value.estimate, { perImage: 0.12 });
    assert.deepEqual(parseImagePricing(fixture(2)).estimate, { perImage: 0.24 });
    const fractional = fixture(0.1); fractional.group_ratio[REFERENCE_GROUP] = 0.05;
    assert.ok(Math.abs(parseImagePricing(fractional).estimate.perImage - 0.005) < 1e-16);
    const unrelated = fixture(); delete unrelated.group_ratio.super; unrelated.group_ratio.high = -1;
    assert.deepEqual(parseImagePricing(unrelated).estimate, { perImage: 0.12 }, 'other groups cannot change the reference price');
    assert.deepEqual(Object.keys(value).sort(), ['estimate', 'group', 'model', 'reason']);
    assert.equal(JSON.stringify(value).includes('not-projected'), false);
});
test('zero is valid; missing, ambiguous or invalid selected group never falls back to another group or a range', () => {
    const zero = fixture(); zero.group_ratio[REFERENCE_GROUP] = 0;
    assert.deepEqual(parseImagePricing(zero).estimate, { perImage: 0 });
    assert.deepEqual(parseImagePricing(fixture(0)).estimate, { perImage: 0 });
    const invalid = [
        p => { delete p.group_ratio[REFERENCE_GROUP]; },
        p => { p.group_ratio[REFERENCE_GROUP] = -1; },
        p => { p.group_ratio[REFERENCE_GROUP] = Infinity; },
        p => { p.group_ratio[REFERENCE_GROUP] = NaN; },
        p => { p.group_ratio[REFERENCE_GROUP] = '0.12'; },
        p => { p.data[0].enable_groups = ['high', 'super']; },
        p => { p.data[0].enable_groups = ['medium']; p.group_ratio.medium = 0.12; },
        p => { p.data[0].enable_groups = [REFERENCE_GROUP, REFERENCE_GROUP]; },
        p => { p.data[0].enable_groups = []; },
        p => { p.group_ratio = null; },
    ];
    for (const mutate of invalid) { const p = fixture(); mutate(p); assert.equal(parseImagePricing(p).estimate, null); }
});
test('unknown billing expressions remain data; exact model, quota, price and fixed expression must agree', () => {
    global.__novaPricingExecuted = false;
    const invalid = [
        p => { p.data[0].billing_expr = 'global.__novaPricingExecuted = true'; },
        p => { p.data[0].billing_expr = 'tier("image", fixed(2)) * image_count'; },
        p => { p.data[0].billing_expr += ' * quality'; },
        p => { p.data[0].billing_mode = 'per_token'; },
        p => { delete p.data[0].billing_expr; },
        p => { p.data[0].quota_type = 0; },
        p => { p.data[0].model_price = '1'; },
        p => { p.data[0].model_price = -1; },
        p => { p.data[0].model_price = Infinity; },
        p => { p.data.push({ ...p.data[0] }); },
        p => { p.data[0].model_name = IMAGE_MODEL + '-other'; },
        p => { p.success = false; },
    ];
    for (const mutate of invalid) { const p = fixture(); mutate(p); assert.equal(parseImagePricing(p).estimate, null); }
    assert.equal(global.__novaPricingExecuted, false); delete global.__novaPricingExecuted;
    const plain = fixture(); delete plain.data[0].billing_mode; delete plain.data[0].billing_expr;
    assert.ok(parseImagePricing(plain).estimate);
});
test('first GET initializes and merges; elapsed time and repeated page reads never refresh the public source', async t => {
    let calls = 0, now = 1000, release;
    const f = await setup(t, { clock: () => now, fetchImpl: async (url, options) => {
        calls++; assert.equal(url, 'https://newapi.opensosen.cn/api/pricing');
        assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
        assert.deepEqual(options.headers, { accept: 'application/json' });
        await new Promise(resolve => { release = resolve; }); return Response.json(fixture());
    } });
    const a = f.service.pricing(f.connection.connectionId), b = f.service.pricing(f.connection.connectionId);
    assert.equal(calls, 1); release();
    const [first, second] = await Promise.all([a, b]);
    assert.deepEqual(first, second); assert.equal(first.cached, false); assert.equal(first.stale, false);
    assert.deepEqual(first.estimate, { perImage: 0.12 });
    now += 86400000;
    for (let index = 0; index < 4; index++) assert.equal((await f.service.pricing(f.connection.connectionId)).cached, true);
    assert.equal(calls, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM connection_checks').get().n, 0);
});
test('actual model refresh updates price once, cached model reads do not, and price failure never changes model verification', async t => {
    let prices = 0, models = 0, price = 1, failPrice = false, failModels = false, now = 1000;
    const f = await setup(t, { allowModelAuth: true, clock: () => now, fetchImpl: async (url, options) => {
        if (new URL(url).pathname === '/v1/models') {
            models++; assert.equal(options.headers.Authorization, 'Bearer synthetic-only-key');
            return failModels ? new Response('', { status: 503 }) : Response.json({ data: [{ id: IMAGE_MODEL }] });
        }
        prices++; assert.equal(options.headers.Authorization, undefined);
        if (failPrice) throw Error('synthetic pricing failure');
        return Response.json(fixture(price));
    } });
    const id = f.connection.connectionId, version = f.connection.connectionVersionId;
    await f.service.pricing(id); price = 2;
    const checked = await f.service.check(id, { connectionVersionId: version, force: true });
    assert.equal(checked.connection.validationState, 'verified'); assert.deepEqual((await f.service.pricing(id)).estimate, { perImage: 0.24 });
    assert.deepEqual([models, prices], [1, 2]);
    await f.service.check(id, { connectionVersionId: version }); f.service.models(id);
    assert.deepEqual([models, prices], [1, 2]);
    now++;
    failPrice = true;
    const failedPrice = await f.service.check(id, { connectionVersionId: version, force: true });
    assert.equal(failedPrice.connection.validationState, 'verified');
    assert.equal((await f.service.pricing(id)).estimate, null, 'failed refresh cannot keep an old quote as new');
    failPrice = false; failModels = true; price = 3; now++;
    const failedModels = await f.service.check(id, { connectionVersionId: version, force: true });
    assert.notEqual(failedModels.connection.validationState, 'verified');
    assert.equal(failedModels.modelsFetchedAt, failedPrice.modelsFetchedAt, 'failed models keep their prior successful timestamp');
    assert.deepEqual((await f.service.pricing(id)).estimate, { perImage: 0.36 }, 'price also refreshes when models fail');
    assert.deepEqual([models, prices], [3, 4]);
});
test('initialization and concurrent model refresh share one in-flight public request', async t => {
    let prices = 0, models = 0, release;
    const f = await setup(t, { allowModelAuth: true, fetchImpl: async url => {
        if (new URL(url).pathname === '/v1/models') { models++; return Response.json({ data: [{ id: IMAGE_MODEL }] }); }
        prices++; return new Promise(resolve => { release = () => resolve(Response.json(fixture())); });
    } });
    const initial = f.service.pricing(f.connection.connectionId);
    const input = { connectionVersionId: f.connection.connectionVersionId, force: true };
    const one = f.service.check(f.connection.connectionId, input), two = f.service.check(f.connection.connectionId, input);
    assert.equal(prices, 1); assert.equal(models, 1); release();
    const [quote, first, second] = await Promise.all([initial, one, two]);
    assert.ok(quote.estimate); assert.equal(first.stale, false); assert.deepEqual(first, second);
    assert.deepEqual([models, prices], [1, 1]);
});
test('unchanged saved validation refreshes pricing without adding awaits after persistence; a new candidate initializes on its first GET', async t => {
    let price = 1, prices = 0;
    const f = await setup(t, { allowModelAuth: true, fetchImpl: async url => {
        if (new URL(url).pathname === '/v1/models') return Response.json({ data: [{ id: IMAGE_MODEL }] });
        prices++; return Response.json(fixture(price));
    } });
    const id = f.connection.connectionId, version = f.connection.connectionVersionId;
    await f.service.pricing(id); price = 2;
    const result = await f.service.validateAndSave({ connectionId: id, expectedVersionId: version, operationId: randomUUID() });
    assert.equal(result.connection.connectionVersionId, version);
    assert.equal(prices, 2); assert.deepEqual((await f.service.pricing(id)).estimate, { perImage: 0.24 });
    const fresh = await f.service.validateAndSave({ apiKey: 'synthetic-candidate', baseUrl: BASES.com, operationId: randomUUID() });
    assert.equal(prices, 2);
    selectGroup(f.service, fresh.connection);
    assert.deepEqual((await f.service.pricing(fresh.connection.connectionId)).estimate, { perImage: 0.24 });
    assert.equal(prices, 3);
});
test('only exact built-in connections fetch public prices; custom hosts never fetch or read keys', async t => {
    let calls = 0;
    const f = await setup(t, { fetchImpl: async () => { calls++; return Response.json(fixture()); } });
    for (const [baseUrl, provider] of [['https://custom.invalid/v1', 'opensosen'], [BASES.cn, 'openai-compatible'], ['https://newapi.opensosen.cn.evil.invalid/v1', 'opensosen']]) {
        const c = f.service.save({ baseUrl, provider });
        assert.equal((await f.service.pricing(c.connectionId)).reason, 'PRICING_UNSUPPORTED');
    }
    assert.equal(calls, 0); await f.service.pricing(f.connection.connectionId); assert.equal(calls, 1);
});
test('route revision scopes reject late quotes and initialize again when switching back to the same origin', async t => {
    const releases = [], urls = [];
    const f = await setup(t, { fetchImpl: async url => { urls.push(url); return new Promise(resolve => releases.push(p => resolve(Response.json(p)))); } });
    const old = f.service.pricing(f.connection.connectionId);
    const com = f.switchRoute('com'), current = f.service.pricing(f.connection.connectionId);
    releases[1](fixture(2)); assert.deepEqual((await current).estimate, { perImage: 0.24 });
    releases[0](fixture()); const stale = await old;
    assert.equal(stale.stale, true); assert.equal(stale.estimate, null); assert.equal(stale.route, 'cn'); assert.equal(stale.routeRevision, 1);
    const cn = f.switchRoute('cn'), backPending = f.service.pricing(cn.connectionId);
    assert.equal(urls.length, 3); releases[2](fixture(3)); const back = await backPending;
    assert.equal(back.stale, false); assert.equal(back.routeRevision, 3); assert.equal(back.cached, false);
    assert.deepEqual(back.estimate, { perImage: 0.36 });
    assert.equal(com.connectionVersionId, cn.connectionVersionId);
    assert.deepEqual(urls, ['https://newapi.opensosen.cn/api/pricing', 'https://newapi.opensosen.com/api/pricing', 'https://newapi.opensosen.cn/api/pricing']);
});
test('changing the key/version isolates late callbacks and the next initialization from old caches', async t => {
    const releases = [];
    const f = await setup(t, { fetchImpl: async () => new Promise(resolve => { releases.push(resolve); }) });
    const pending = f.service.pricing(f.connection.connectionId);
    const next = f.service.save({ connectionId: f.connection.connectionId, expectedVersionId: f.connection.connectionVersionId, apiKey: 'another-synthetic-key' });
    selectGroup(f.service, next);
    const current = f.service.pricing(next.connectionId);
    assert.equal(releases.length, 2);
    releases[1](Response.json(fixture(2))); assert.deepEqual((await current).estimate, { perImage: 0.24 });
    releases[0](Response.json(fixture())); assert.equal((await pending).stale, true);
    assert.deepEqual((await f.service.pricing(next.connectionId)).estimate, { perImage: 0.24 });
});
test('failed initialization is cached until explicit model refresh; it does not leak upstream errors or modify connection state', async t => {
    let calls = 0, now = 0;
    const f = await setup(t, { clock: () => now, fetchImpl: async () => { calls++; throw Error('upstream text must not leak'); } });
    const before = f.service.summary(f.connection.connectionId), failed = await f.service.pricing(before.connectionId);
    assert.equal(failed.reason, 'PRICING_UNAVAILABLE'); assert.equal(failed.estimate, null);
    assert.deepEqual(f.service.summary(before.connectionId), before);
    now = 86400000;
    assert.equal((await f.service.pricing(before.connectionId)).cached, true); assert.equal(calls, 1);
    assert.equal(JSON.stringify(failed).includes('upstream text'), false);
});
test('non-200, upstream failure, redirects, oversized/malformed data and stalled reads cannot become quotes', async () => {
    for (const status of [206, 301, 302, 401, 500]) {
        const load = createImagePricing({ fetchImpl: async (_url, options) => {
            assert.equal(options.redirect, 'manual');
            return new Response(JSON.stringify(fixture()), { status, headers: { location: 'https://untrusted.invalid' } });
        } });
        assert.equal((await load('cn')).estimate, null);
    }
    const cases = [
        async () => Response.json({ ...fixture(), success: false }),
        async () => new Response('{'),
        async () => new Response(JSON.stringify(fixture()), { headers: { 'content-length': '2048' } }),
        async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1025)); c.close(); } })),
        async () => new Promise(() => {}),
        async () => new Response(new ReadableStream({ start() {} })),
    ];
    for (const fetchImpl of cases) assert.equal((await createImagePricing({ fetchImpl, timeoutMs: 20, maxBytes: 1024 })('cn')).estimate, null);
    let calls = 0;
    const load = createImagePricing({ fetchImpl: async () => { calls++; return Response.json(fixture()); } });
    assert.equal((await load('evil')).reason, 'PRICING_UNSUPPORTED'); assert.equal(calls, 0);
    for (let index = 0; index < 70; index++) await load('cn', { scope: 'scope-' + index });
    assert.equal((await load('cn', { scope: 'scope-69' })).cached, true); assert.equal(calls, 70);
    assert.equal((await load('cn', { scope: 'scope-0' })).cached, false); assert.equal(calls, 71, 'old completed scopes are bounded');
});
test('actual protected HTTP pricing GET is anonymous upstream and repeated local reads never refresh it', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-image-reference-http-')), calls = [];
    const upstream = http.createServer((req, res) => {
        calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, session: req.headers['x-nova-session'] });
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture()));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const runtime = await start(directory, { opensosenOrigin: 'http://127.0.0.1:' + upstream.address().port });
    t.after(async () => { await runtime.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); cleanup(directory); });
    const connection = await runtime.saveConnection({ baseUrl: BASES.com, apiKey: 'synthetic-http-pricing-key' });
    const url = '/api/nova/connections/' + connection.connectionId + '/pricing';
    assert.equal((await fetch(runtime.origin + url)).status, 403);
    const missing = await (await runtime.request(url)).json(); assert.equal(missing.reason, 'PRICING_GROUP_REQUIRED');
    const catalog = await (await runtime.request('/api/nova/connections/' + connection.connectionId + '/models')).json(), {revision,...settings}=catalog.displaySettings;
    const saved = await runtime.request('/api/nova/connections/' + connection.connectionId + '/model-display', {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({connectionVersionId:connection.connectionVersionId,expectedRouteRevision:catalog.routeRevision,expectedRevision:revision,...settings,imageModels:[],videoModels:[],defaultImageModel:null,defaultVideoModel:null,pricingGroup:REFERENCE_GROUP})}); assert.equal(saved.status,200);
    const response = await runtime.request(url); assert.equal(response.status, 200);
    const value = await response.json(); assert.deepEqual(value.estimate, { perImage: 0.12 });
    for (let index = 0; index < 3; index++) assert.equal((await (await runtime.request(url)).json()).cached, true);
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/pricing', authorization: undefined, session: undefined }]);
    assert.equal((await runtime.request(url, { method: 'POST' })).status, 405);
    assert.equal(JSON.stringify(value).includes('not-projected'), false); assert.equal(JSON.stringify(value).includes('synthetic-http-pricing-key'), false);
    assert.equal((await (await runtime.request('/api/nova/connections/current')).json()).connection.validationState, 'unverified');
});
