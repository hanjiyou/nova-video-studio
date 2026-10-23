'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { startMockProvider, verifyMultipart, FIXTURE_TOKEN, FIXTURE_DIR, DEFAULT_DOWNLOAD } = require('./support/mock-provider');
const { assertUrlAllowed } = require('../plugin-runtime/executor');
const headers = { Authorization: `Bearer ${FIXTURE_TOKEN}`, 'Content-Type': 'application/json' };
const prompt = '中文剧情\n他说：“你好”。保持顺序和原始图片。';
async function provider(t, options) { const value = await startMockProvider(options); t.after(() => value.close()); return value; }
const post = (mock, init = {}) => fetch(`${mock.baseUrl}/videos`, { method: 'POST', headers, body: JSON.stringify({ model: 'synthetic-text-transport', prompt }), ...init });
async function until(check) { const deadline = Date.now() + 2000; while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Mock observation timed out'); }
function multipartFixture(name) {
  const { request } = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  const form = new FormData();
  for (const { name, value } of request.fields) form.append(name, value);
  const files = request.files.map(file => ({ name: file.name, fileName: file.fixtureFile, mimeType: file.mimeType, bytes: fs.readFileSync(path.join(FIXTURE_DIR, file.fixtureFile)) }));
  for (const file of files) form.append(file.name, new Blob([file.bytes], { type: file.mimeType }), file.fileName);
  // FormData normalizes scalar line endings on the wire, never binary file contents.
  const wireFields = request.fields.map(field => ({ ...field, value: field.value.replace(/\r\n|\r|\n/g, '\r\n') }));
  return { form, expected: { fields: wireFields, files } };
}

test('mock binds loopback and captures JSON with Chinese/newline/quotes exactly', async t => {
  const mock = await provider(t, { host: '0.0.0.0' });
  assert.equal(new URL(mock.baseUrl).hostname, '127.0.0.1');
  const response = await post(mock);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'queued');
  assert.equal(mock.requests[0].json.prompt, prompt);
  assert.equal(mock.requests[0].bodyComplete, true);
  assert.equal(mock.count('POST', '/v1/videos'), 1);
  assert.doesNotMatch(JSON.stringify(mock.requests), /fixture-token/);
});

for (const [name, count] of [['video-single-request.json', 1], ['video-dual-request.json', 2]]) {
  test(`multipart ${count} file(s): repeated input_reference, original bytes, MIME and order`, async t => {
    const mock = await provider(t);
    const { form, expected } = multipartFixture(name);
    const response = await post(mock, { headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` }, body: form });
    assert.equal(response.status, 200);
    verifyMultipart(mock.requests[0], expected);
    assert.equal(mock.requests[0].parts.filter(part => part.kind === 'file').length, count);
    assert.equal(mock.counters.submitPosts, 1);
  });
}

test('multipart verifier detects swapped files, modified bytes and wrong field names', async t => {
  const mock = await provider(t);
  const { form, expected } = multipartFixture('video-dual-request.json');
  await (await post(mock, { headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` }, body: form })).text();
  assert.throws(() => verifyMultipart(mock.requests[0], { ...expected, files: [...expected.files].reverse() }), /file name\/order/);
  const altered = expected.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }));
  altered[0].bytes[10] ^= 255;
  assert.throws(() => verifyMultipart(mock.requests[0], { ...expected, files: altered }), /original bytes\/order/);
  assert.throws(() => verifyMultipart(mock.requests[0], { ...expected, files: expected.files.map(file => ({ ...file, name: 'input_reference[]' })) }), /field name/);
});

test('missing multipart boundary is rejected and still counted as one POST', async t => {
  const mock = await provider(t);
  const response = await post(mock, { headers: { ...headers, 'Content-Type': 'multipart/form-data' }, body: 'not-a-valid-multipart-body' });
  assert.equal(response.status, 400);
  assert.equal(mock.counters.submitPosts, 1);
  assert.equal(mock.counters.acceptedCreates, 0);
});

for (const status of [401, 403]) {
  test(`synthetic ${status} authentication rejection does not create a task or retain the token`, async t => {
    const mock = await provider(t, { authFailureStatus: status });
    const response = await post(mock, { headers: { ...headers, Authorization: 'Bearer deliberately-wrong-fixture' } });
    assert.equal(response.status, status);
    assert.equal(mock.taskIds.length, 0);
    assert.equal(mock.counters.submitPosts, 1);
    assert.doesNotMatch(JSON.stringify(mock.requests), /deliberately-wrong-fixture/);
  });
}

test('create, poll generating, poll remote-completed; remote completion is not local file completion', async t => {
  const mock = await provider(t);
  const created = await (await post(mock)).json();
  assert.equal(created.status, 'queued');
  const generating = await (await fetch(`${mock.baseUrl}/videos/${created.id}`, { headers })).json();
  assert.equal(generating.status, 'in_progress');
  const completed = await (await fetch(`${mock.baseUrl}/videos/${created.id}`, { headers })).json();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.size, '16:9'); // Observed response differs from requested pixel size.
  assert.equal(completed.localState, undefined);
  assert.equal(completed.assetId, undefined);
  assert.deepEqual(mock.counters, { submitPosts: 1, pollGets: 2, downloadGets: 0, acceptedCreates: 1 });
});

test('counter detects repeated creation even with the same local request/idempotency headers', async t => {
  const mock = await provider(t);
  const repeatedHeaders = { ...headers, 'X-Local-Request-Id': 'local_fixture_1', 'Idempotency-Key': 'unverified_fixture_key' };
  const first = await (await post(mock, { headers: repeatedHeaders })).json();
  const second = await (await post(mock, { headers: repeatedHeaders })).json();
  assert.notEqual(first.id, second.id);
  assert.equal(mock.counters.submitPosts, 2);
  assert.equal(mock.counters.acceptedCreates, 2);
});

test('client timeout after mock acceptance leaves one accepted POST, then GET can query the same ID', async t => {
  const mock = await provider(t, { submitSteps: [{ delayMs: 500 }] });
  const controller = new AbortController();
  const pending = post(mock, { signal: controller.signal }).catch(error => error);
  await until(() => mock.taskIds.length === 1);
  controller.abort();
  assert.ok(await pending instanceof Error);
  const knownOnlyToHarness = mock.taskIds[0];
  assert.equal((await fetch(`${mock.baseUrl}/videos/${knownOnlyToHarness}`, { headers })).status, 200);
  assert.equal(mock.counters.submitPosts, 1);
  assert.equal(mock.counters.acceptedCreates, 1);
  // This observes uncertainty; it does not claim a production client can recover an ID it never saved.
});

test('connection can drop after accepting a POST without returning its task ID', async t => {
  const mock = await provider(t, { submitSteps: [{ disconnect: 'after_accept' }] });
  await assert.rejects(post(mock));
  assert.equal(mock.counters.submitPosts, 1);
  assert.equal(mock.taskIds.length, 1);
  assert.equal(mock.counters.acceptedCreates, 1);
});

test('HTTP200 create body can be truncated after acceptance', async t => {
  const mock = await provider(t, { submitSteps: [{ disconnect: 'mid_body' }] });
  const response = await post(mock);
  assert.equal(response.status, 200);
  await assert.rejects(response.json());
  assert.equal(mock.counters.submitPosts, 1);
  assert.equal(mock.counters.acceptedCreates, 1);
});

test('poll fixtures support bounded-policy inputs: 429 Retry-After, 503 and unknown state', async t => {
  const id = 'task_fixture_resume';
  const mock = await provider(t, { seedTasks: [{ id }], pollSteps: [
    { status: 429, headers: { 'Retry-After': '999999' }, body: { error: 'synthetic limit' } },
    { status: 503, body: { error: 'synthetic transient' } },
    { status: 200, body: { id, status: 'new_provider_state' } },
  ] });
  const limited = await fetch(`${mock.baseUrl}/videos/${id}`, { headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '999999');
  assert.equal((await fetch(`${mock.baseUrl}/videos/${id}`, { headers })).status, 503);
  assert.equal((await (await fetch(`${mock.baseUrl}/videos/${id}`, { headers })).json()).status, 'new_provider_state');
  assert.equal(mock.counters.submitPosts, 0);
  assert.equal(mock.counters.pollGets, 3);
});

test('POST429 fixture is observable once; it does not imply a safe automatic resubmit', async t => {
  const mock = await provider(t, { submitSteps: [{ status: 429, body: { error: 'synthetic create limit' }, headers: { 'Retry-After': '1' } }] });
  assert.equal((await post(mock)).status, 429);
  assert.equal(mock.counters.submitPosts, 1);
  assert.equal(mock.counters.acceptedCreates, 0);
});

test('download 503, retry and Range operate on the same task without generation POSTs', async t => {
  const id = 'task_fixture_download';
  const mock = await provider(t, { seedTasks: [{ id }], downloadSteps: [{ status: 503, body: { error: 'synthetic download failure' } }, {}] });
  const url = `${mock.baseUrl}/videos/${id}/content`;
  assert.equal((await fetch(url, { headers })).status, 503);
  const response = await fetch(url, { headers: { ...headers, Range: 'bytes=2-6' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 2-6/${DEFAULT_DOWNLOAD.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), DEFAULT_DOWNLOAD.subarray(2, 7));
  assert.equal(mock.counters.submitPosts, 0);
  assert.equal(mock.counters.downloadGets, 2);
});

test('download fault fixtures include truncated bodies and JSON labelled as MP4', async t => {
  const id = 'task_fixture_bad_media';
  const mock = await provider(t, { seedTasks: [{ id }], downloadSteps: [
    { disconnect: 'mid_body' },
    { body: { error: 'synthetic JSON masquerading as video' }, headers: { 'Content-Type': 'video/mp4' } },
  ] });
  const url = `${mock.baseUrl}/videos/${id}/content`;
  await assert.rejects((await fetch(url, { headers })).arrayBuffer());
  const invalid = await fetch(url, { headers });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.headers.get('content-type'), 'video/mp4');
  assert.match(await invalid.text(), /masquerading/);
  assert.equal(mock.counters.submitPosts, 0);
});

test('test request memory budget rejects oversized bodies', async t => {
  const mock = await provider(t, { maxBodyBytes: 100 });
  assert.equal((await post(mock, { body: JSON.stringify({ prompt: 'a'.repeat(1000) }) })).status, 413);
  assert.equal(mock.counters.acceptedCreates, 0);
});

test('production plugin loopback guard is unchanged; mock is used directly by tests', () => {
  const plugin = { id: 'fixture-guard', manifest: { permissions: { hosts: ['127.0.0.1'] } } };
  assert.throws(() => assertUrlAllowed(plugin, 'http://127.0.0.1:12345/v1/videos', 'fixture'), /不能访问内网/);
});

for (const remoteState of ['failed', 'cancelled']) {
  test(`synthetic remote ${remoteState} query is independent of an active cancellation endpoint`, async t => {
    const id = 'task_fixture_remote_result';
    const mock = await provider(t, { seedTasks: [{ id }], pollSteps: [{ status: 200, body: { id, status: remoteState, error: { message: 'synthetic unobserved provider failure shape' } } }] });
    const result = await (await fetch(`${mock.baseUrl}/videos/${id}`, { headers })).json();
    assert.equal(result.status, remoteState);
    assert.equal((await fetch(`${mock.baseUrl}/videos/${id}/cancel`, { method: 'POST', headers })).status, 404);
    assert.equal(mock.counters.submitPosts, 0);
  });
}
