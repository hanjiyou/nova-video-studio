'use strict';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');
const { createDesktopBoundary, SESSION_HEADER } = require('../desktop-session');
const { createNetworkPolicy } = require('../../desktop/network.cjs');
const { createSessionPolicy } = require('../../desktop/session-policy.cjs');
const { registerDesktopIpc } = require('../../desktop/ipc.cjs');
const { resolveDataPolicy, resolveBackendPort } = require('../../desktop/runtime.cjs');
const { startMockProvider, FIXTURE_TOKEN } = require('./support/mock-provider');
const { start } = require('./support/desktop-http-runtime.cjs');
const token = () => randomBytes(32).toString('hex');
const backendOrigin = 'http://127.0.0.1:31207';
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); };
async function until(fn, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timed out'); }

test('desktop boundary fails closed for no-Origin clients, hostile sources, wrong host and revoked sessions', () => {
  const secret = token();
  const boundary = createDesktopBoundary({ token: secret, origin: backendOrigin });
  const req = headers => ({ headers: { host: '127.0.0.1:31207', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(boundary.authorize(req({})).ok, false);
  assert.equal(boundary.authorize(req({ [SESSION_HEADER]: secret })).ok, true);
  for (const headers of [{ [SESSION_HEADER]: 'wrong' }, { [SESSION_HEADER]: secret, origin: 'https://attacker.invalid' }, { [SESSION_HEADER]: secret, host: 'localhost:31207' }, { [SESSION_HEADER]: secret, 'sec-fetch-site': 'cross-site' }, { [SESSION_HEADER]: secret, origin: 'null' }]) assert.equal(boundary.authorize(req(headers)).ok, false);
  assert.equal(boundary.authorize({ ...req({ [SESSION_HEADER]: secret }), socket: { remoteAddress: '192.0.2.10' } }).ok, false);
  assert.equal(boundary.authorize(req({}), { sensitive: false }).ok, true);
  assert.equal(boundary.authorize(req({ [SESSION_HEADER]: secret }), { websocket: true }).ok, false);
  assert.equal(boundary.authorize(req({ [SESSION_HEADER]: secret, origin: backendOrigin }), { websocket: true }).ok, true);
  boundary.revoke();
  assert.equal(boundary.authorize(req({ [SESSION_HEADER]: secret })).ok, false);
});

test('session injection requires the actual main frame and strips caller headers on all other requests', () => {
  const frame = { url: backendOrigin + '/' };
  const contents = { id: 17, mainFrame: frame, isDestroyed: () => false };
  const secret = token();
  const policy = createSessionPolicy({ origin: backendOrigin, token: secret, getWebContents: () => contents });
  const details = { url: backendOrigin + '/api/nova/config', webContentsId: 17, frame, requestHeaders: { 'X-Nova-Session': 'renderer-value', accept: 'application/json' } };
  assert.equal(policy.beforeSendHeaders(details).requestHeaders[SESSION_HEADER], secret);
  for (const changes of [{ frame: undefined }, { frame: { url: frame.url } }, { webContentsId: 18 }, { url: 'https://remote.invalid/api' }, { url: backendOrigin.replace('127.0.0.1', 'localhost') }]) {
    const headers = policy.beforeSendHeaders({ ...details, ...changes }).requestHeaders;
    assert.ok(!Object.keys(headers).some(key => key.toLowerCase() === SESSION_HEADER));
  }
  assert.equal(policy.beforeSendHeaders({ ...details, requestHeaders: { 'Service-Worker': 'script' } }).cancel, true);
  assert.equal(policy.beforeRequest({ resourceType: 'subFrame', url: backendOrigin }).cancel, true);
  assert.equal(policy.beforeRequest({ resourceType: 'mainFrame', url: 'https://remote.invalid' }).cancel, true);
  const csp = policy.headersReceived({ resourceType: 'mainFrame', url: backendOrigin, responseHeaders: {} }).responseHeaders['Content-Security-Policy'];
  assert.deepEqual(csp, ["worker-src 'none'; frame-src 'none'"]);
  const event = { sender: contents, senderFrame: frame };
  assert.equal(policy.isTrustedSender(event), true);
  assert.equal(policy.isTrustedSender({ ...event, senderFrame: { url: frame.url } }), false);
});

test('narrow IPC accepts only the main frame and opaque selections/asset IDs', async t => {
  const handlers = new Map();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ipc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ipc = registerDesktopIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) }, dialog: { showOpenDialog: async () => ({ filePaths: [directory], canceled: false }) }, getWindow: () => ({}), policy: { isTrustedSender: event => event.trusted === true }, runtimeInfo: () => ({ version: 'test', storageMode: 'override' }) });
  const call = (channel, ...args) => handlers.get(channel)({ trusted: true }, ...args);
  assert.equal((await handlers.get('nova:runtime-info')({ trusted: false })).code, 'IPC_FORBIDDEN');
  assert.equal((await call('nova:runtime-info', '/arbitrary/path')).code, 'INVALID_ARGUMENT');
  const choice = await call('nova:choose-output-directory');
  assert.equal(choice.ok, true);
  assert.ok(choice.selectionId);
  assert.equal(JSON.stringify(choice).includes(directory), false);
  assert.equal(ipc.resolveDirectorySelection(choice.selectionId), await fs.promises.realpath(directory));
  assert.deepEqual(fs.readdirSync(directory), []);
  for (const channel of ['nova:save-asset-copy', 'nova:reveal-asset']) {
    for (const id of ['C:\\secret.txt', '../secret', { assetId: 'x' }, undefined]) assert.equal((await call(channel, id)).code, 'INVALID_ASSET_ID');
    assert.equal((await call(channel, '00000000-0000-4000-8000-000000000001')).code, 'ASSET_SERVICE_NOT_READY');
  }
  ipc.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(ipc.resolveDirectorySelection(choice.selectionId), null);
});

test('data policy precedence and bounded loopback port selection', async t => {
  assert.deepEqual(resolveDataPolicy({ env: {}, systemUserData: 'system' }), { mode: 'system', directory: 'system' });
  assert.equal(resolveDataPolicy({ env: { PORTABLE_EXECUTABLE_DIR: '.' }, systemUserData: 'system' }).directory, path.join(process.cwd(), 'data'));
  assert.equal(resolveDataPolicy({ env: { NOVA_DATA_DIR: './override', PORTABLE_EXECUTABLE_DIR: '.' }, systemUserData: 'system' }).mode, 'override');
  const server = http.createServer();
  const occupied = await listen(server);
  t.after(() => close(server));
  assert.notEqual(await resolveBackendPort(occupied), occupied);
  assert.ok(await resolveBackendPort(0) > 0);
  await assert.rejects(resolveBackendPort(-1));
});

for (const [name, step] of Object.entries({ accepted: {}, timeout: { delayMs: 180 }, after_accept: { disconnect: 'after_accept' }, mid_body: { disconnect: 'mid_body' }, http429: { status: 429 }, http503: { status: 503 }, redirect307: { status: 307, headers: { location: '/v1/videos' } } })) {
  test('production network policy sends exactly one generation POST: ' + name, async t => {
    const provider = await startMockProvider({ submitSteps: [step] });
    t.after(() => provider.close());
    let proxyCalls = 0;
    const policy = createNetworkPolicy({ directFetch: fetch, proxyFetch: (...args) => { proxyCalls++; return fetch(...args); }, backendOrigin, mode: 'direct-first', timeoutMs: name === 'timeout' ? 35 : 2000, fallbackDelayMs: 1 });
    try {
      const response = await policy.fetch(provider.baseUrl + '/videos', { method: 'POST', redirect: 'follow', headers: { authorization: 'Bearer ' + FIXTURE_TOKEN, 'content-type': 'application/json', [SESSION_HEADER]: token() }, body: JSON.stringify({ model: 'fixture-model', prompt: 'synthetic' }) });
      await response.arrayBuffer();
      if (name === 'redirect307') assert.equal(response.status, 307);
    } catch (error) {
      assert.ok(['timeout', 'after_accept', 'mid_body'].includes(name), error.message);
      if (name !== 'mid_body') assert.equal(error.code, 'SUBMISSION_UNKNOWN');
    }
    assert.equal(provider.counters.submitPosts, 1);
    assert.equal(proxyCalls, 0);
  });
}

test('GET fallback is bounded, respects Retry-After and cancellation; internal redirects stay manual', async () => {
  let calls = 0;
  const policy = createNetworkPolicy({ directFetch: async (_input, init) => { calls++; assert.equal(init.headers.has(SESSION_HEADER), false); return new Response('{}', { status: 503 }); }, proxyFetch: async () => { calls++; return new Response('{}', { status: 503 }); }, backendOrigin, mode: 'direct-first', fallbackDelayMs: 1 });
  assert.equal((await policy.fetch('https://remote.invalid/models', { headers: { [SESSION_HEADER]: token() } })).status, 503);
  assert.equal(calls, 2);
  calls = 0;
  const waits = createNetworkPolicy({ directFetch: async () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }), proxyFetch: async () => { calls++; }, backendOrigin, mode: 'direct-first', maxFallbackWaitMs: 10 });
  assert.equal((await waits.fetch('https://remote.invalid/models')).status, 429);
  assert.equal(calls, 0);
  const aborted = new AbortController(); aborted.abort();
  const cancelled = createNetworkPolicy({ directFetch: async () => { throw new Error('abort'); }, proxyFetch: async () => { calls++; }, backendOrigin, mode: 'direct-first' });
  await assert.rejects(cancelled.fetch('https://remote.invalid/models', { signal: aborted.signal }));
  assert.equal(calls, 0);
  const internal = createNetworkPolicy({ directFetch: async (_url, init) => { assert.equal(init.redirect, 'manual'); return new Response(); }, proxyFetch: async () => { throw new Error('unexpected fallback'); }, backendOrigin, mode: 'direct-first' });
  await internal.fetch(backendOrigin + '/api/nova/config');
});

test('system mode uses one configured transport and abortPending cancels in-flight creation', async () => {
  let calls = 0;
  const policy = createNetworkPolicy({ directFetch: async () => { throw new Error('unexpected direct'); }, proxyFetch: async (_url, init) => { calls++; assert.equal(init.redirect, 'manual'); assert.equal(init.headers.has(SESSION_HEADER), false); return new Response(); }, backendOrigin, mode: 'system' });
  await policy.fetch('https://remote.invalid/create', { method: 'POST', headers: { [SESSION_HEADER]: token() } });
  assert.equal(calls, 1);
  const hanging = createNetworkPolicy({ directFetch: async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })), proxyFetch: fetch, backendOrigin });
  const result = hanging.fetch('https://remote.invalid/create', { method: 'POST' });
  hanging.abortPending();
  await assert.rejects(result, { code: 'SUBMISSION_UNKNOWN' });
});

async function startDesktopBackend(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-desktop-server-'));
  const runtime=await start(directory,{imageStream:true});
  t.after(async()=>{await runtime.stop();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  return runtime;
}

function wsStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 2000 });
    socket.once('open', () => { socket.close(); resolve(101); });
    socket.once('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
    socket.on('error', error => { if (!/closed before/.test(error.message)) reject(error); });
  });
}
test('actual backend protects HTTP and WS including no-Origin clients and never retries rejected desktop stream POST', async t => {
  const { origin, headers, secret, saveConnection } = await startDesktopBackend(t);
  let candidateIndex = 0;
  for (const candidate of [{}, { [SESSION_HEADER]: 'wrong' }, { ...headers, Origin: 'https://attacker.invalid' }, { ...headers, Host: 'attacker.invalid' }, { ...headers, 'sec-fetch-site': 'cross-site' }]) {
    const status = await new Promise((resolve, reject) => { const request = http.get(origin + '/api/nova/config', { headers: candidate }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
    assert.equal(status, 403, 'unauthorized candidate ' + candidateIndex++);
  }
  assert.equal((await fetch(origin + '/api/nova/config', { headers })).status, 200);
  assert.equal((await fetch(origin + '/api/nova/config', { headers: { ...headers, Origin: origin } })).status, 200);
  const wsUrl = origin.replace('http:', 'ws:') + '/api/nova/ws';
  for (const candidate of [{}, headers, { Origin: origin }, { ...headers, Origin: 'https://attacker.invalid' }]) assert.equal(await wsStatus(wsUrl, candidate), 403);
  assert.equal(await wsStatus(wsUrl, { ...headers, Origin: origin }), 101);
  let postCount = 0;
  const upstream = http.createServer(async (req, res) => { for await (const chunk of req) { void chunk; } postCount++; res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Unsupported parameter: partial_images' } })); });
  const upstreamPort = await listen(upstream);
  const connection=await saveConnection({baseUrl:'http://127.0.0.1:'+upstreamPort,apiKey:FIXTURE_TOKEN});
  t.after(() => close(upstream));
  const created = await fetch(origin + '/api/nova/tasks', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ connectionVersionId:connection.connectionVersionId, mode: 'text-to-image', prompt: 'synthetic', model: 'gpt-image-1', parallelCount: 1, outputSize: 'auto', aspectRatio: 'auto', images: [] }) });
  assert.equal(created.status, 202);
  const { taskId } = await created.json();
  const task = await until(async () => { const value = await (await fetch(origin + '/api/nova/tasks/' + taskId, { headers })).json(); return ['completed', 'failed'].includes(value.status) ? value : null; });
  assert.equal(task.status, 'failed');
  assert.equal(postCount, 1);
  assert.equal(JSON.stringify(task).includes(secret), false);
});
