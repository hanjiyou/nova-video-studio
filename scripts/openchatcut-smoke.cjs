'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createServer } = require('node:http');
const { inspectOpenChatCutRuntime, createOpenChatCutServiceEnvironment, hashFile } = require('./openchatcut-runtime.cjs');

async function start(runtime, directory, execPath) {
  const env = createOpenChatCutServiceEnvironment({ dataDirectory: directory, distDirectory: runtime.distDir });
  const child = fork(runtime.servicePath, [], { execPath, execArgv: [], cwd: runtime.workingDirectory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Native logs can include paths. Consume them, but never forward to the report.
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('EDITOR_SMOKE_START_TIMEOUT')), 30000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('EDITOR_SMOKE_SPAWN_FAILED')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('EDITOR_SMOKE_EARLY_EXIT')); });
      child.on('message', message => {
        if (message?.type === 'openchatcut:failed') { clearTimeout(timer); reject(new Error(message.code)); }
        if (message?.type === 'openchatcut:ready') { clearTimeout(timer); resolve(message); }
      });
    });
    const origin = new URL(ready.origin);
    assert.equal(origin.hostname, '127.0.0.1'); assert.equal(origin.protocol, 'http:');
    assert.match(ready.editorPath, /^\/#\/editor\/[a-f0-9-]{36}$/);
    const stop = async () => {
      if (child.connected) child.send({ type: 'openchatcut:stop' });
      const timeout = setTimeout(() => child.kill(), 5000);
      const outcome = await exited; clearTimeout(timeout); assert.equal(outcome.code, 0);
    };
    return { ready, child, stop };
  } catch (error) { child.kill(); await exited; throw error; }
}

async function runSmoke({ execPath = process.execPath } = {}) {
  const runtime = inspectOpenChatCutRuntime();
  if (!runtime.available) throw new Error(runtime.code);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-occ-smoke-'));
  let service;
  let occupiedPort;
  let stage = 'start';
  try {
    service = await start(runtime, profile, execPath);
    const { origin, editorPath } = service.ready;
    const headers = { origin, 'sec-fetch-site': 'same-origin' };
    stage = 'html';
    const page = await fetch(origin, { headers });
    assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /id="root"/);
    const script = html.match(/<script[^>]+src="([^"]+)"/);
    assert.ok(script); assert.equal((await fetch(new URL(script[1], origin), { headers })).status, 200);
    stage = 'project-read';
    const projectId = editorPath.split('/').pop();
    const endpoint = `${origin}/api/project-store/entry?key=${encodeURIComponent('project:' + projectId)}`;
    const entryResponse = await fetch(endpoint, { headers }); assert.equal(entryResponse.status, 200);
    const entry = await entryResponse.json(); assert.equal(entry.found, true);
    assert.ok(entry.value.activeTimelineId); assert.ok(entry.value.timelines.length);
    const assertRestoredProject = async () => {
      assert.equal(service.ready.editorPath, editorPath);
      const restored = await fetch(service.ready.origin + '/api/project-store/entry?key=' + encodeURIComponent('project:' + projectId), { headers: { origin: service.ready.origin, 'sec-fetch-site': 'same-origin' } });
      assert.equal(restored.status, 200); assert.deepEqual((await restored.json()).value, entry.value);
    };
    stage = 'key-write-block';
    const configurationFootprint = () => ['settings.env', '.env.local'].map(name => {
      const file = path.join(profile, name);
      return fs.existsSync(file) ? hashFile(file) : null;
    });
    const beforeKeyWrite = configurationFootprint();
    const keys = await fetch(origin + '/api/keys', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ OPENAI_API_KEY: 'offline-placeholder' }) });
    assert.equal(keys.status, 503); assert.equal((await keys.json()).code, 'EDITOR_CREDENTIAL_BRIDGE_NOT_READY');
    for (const blocked of ['/api/keys/test', '/api/skills/install', '/api/external-mcp/mcp']) {
      const response = await fetch(origin + blocked, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 503);
    }
    assert.deepEqual(configurationFootprint(), beforeKeyWrite);
    stage = 'cross-origin-read';
    assert.equal((await fetch(endpoint, { headers: { origin: 'https://foreign.invalid', 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.ok(fs.existsSync(path.join(profile, 'project-store-v1.sqlite3')));
    stage = 'stop';
    await service.stop(); service = null;
    stage = 'restart';
    service = await start(runtime, profile, execPath);
    assert.equal(service.ready.origin, origin);
    await assertRestoredProject();
    await service.stop(); service = null;
    stage = 'port-collision';
    occupiedPort = createServer((_req, res) => { res.writeHead(503); res.end(); });
    await new Promise((resolve, reject) => { occupiedPort.once('error', reject); occupiedPort.listen(Number(new URL(origin).port), '127.0.0.1', resolve); });
    service = await start(runtime, profile, execPath);
    const fallbackOrigin = service.ready.origin;
    assert.notEqual(fallbackOrigin, origin);
    await assertRestoredProject();
    await service.stop(); service = null;
    await new Promise(resolve => occupiedPort.close(resolve)); occupiedPort = null;
    stage = 'fallback-port-restart';
    service = await start(runtime, profile, execPath);
    assert.equal(service.ready.origin, fallbackOrigin);
    await assertRestoredProject();
    await service.stop(); service = null;
    return { passed: true, engineCommit: runtime.engineCommit, checks: ['native-html', 'frontend-script', 'sqlite-project-read', 'restart-project-recovery', 'stable-restart-origin', 'occupied-port-fallback', 'remembered-fallback-origin', 'plaintext-key-write-blocked', 'cross-origin-project-read-blocked', 'graceful-shutdown'], credentials: false, cloudCalls: false };
  } catch (error) { error.smokeStage = stage; throw error; } finally {
    if (service) await service.stop().catch(() => service.child.kill());
    if (occupiedPort) await new Promise(resolve => occupiedPort.close(resolve));
    const temporary = path.resolve(profile);
    if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('nova-occ-smoke-')) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
module.exports = { runSmoke };
if (require.main === module) {
  const execPath = process.argv.includes('--electron') ? path.join(__dirname, '..', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron') : process.execPath;
  runSmoke({ execPath }).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(JSON.stringify({ code: /^EDITOR_[A-Z_]+$/.test(error.message) ? error.message : 'EDITOR_SMOKE_ASSERTION_FAILED', stage: error.smokeStage || 'precheck', assertion: typeof error.actual === 'number' || typeof error.actual === 'boolean' ? { actual: error.actual, expected: error.expected } : undefined }) + '\n'); process.exitCode = 1; });
}
