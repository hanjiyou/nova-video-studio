// T00-only startup smoke: real Electron, local HTTP/CDP, no provider requests.
// Usage: node scripts/verify-desktop-baseline.cjs --output temp/t00-baseline/dev
//        node scripts/verify-desktop-baseline.cjs --executable <installed.exe> --output <dir>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const WebSocket = require('ws');

const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(args[index + 1], `Missing value for ${name}`);
  return args[index + 1];
};
const executableArg = option('--executable', null);
const executable = executableArg ? path.resolve(executableArg) : require('electron');
const outputDir = path.resolve(option('--output', path.join(repo, 'temp/t00-baseline/dev')));
fs.mkdirSync(outputDir, { recursive: true });
const defaultInstalledData = args.includes('--default-installed-data');
assert.ok(!defaultInstalledData || executableArg, 'Default installed data requires --executable');
const dataDir = defaultInstalledData ? path.join(path.dirname(executable), 'data') : path.join(outputDir, 'data');
assert.ok(!fs.existsSync(dataDir), 'Use a new output directory to prove first-run startup');
const evidence = { startedAt: new Date().toISOString(), executable, outputDir, packaged: Boolean(executableArg), dataPolicy: defaultInstalledData ? 'original installed default' : 'isolated NOVA_DATA_DIR', providerRequests: 'none; only local config/queue/DOM inspection' };
let child;
let client;
let childExit = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function until(fn, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let error;
  while (Date.now() < deadline) {
    if (childExit) throw new Error(`Electron exited before readiness: ${JSON.stringify(childExit)}`);
    try { const value = await fn(); if (value) return value; } catch (current) { error = current; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw error || new Error('Readiness timed out');
}
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  assert.equal(response.status, 200, url);
  return response.json();
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP socket closed')); }
    pending.clear();
  });
  return {
    exceptions,
    close: () => socket.close(),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}
async function waitForExit(timeoutMs = 10000) {
  if (childExit) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

(async () => {
  const backendPort = await freePort();
  const debugPort = await freePort();
  evidence.backendUrl = `http://127.0.0.1:${backendPort}`;
  const env = { ...process.env, NODE_ENV: 'production', NOVA_DATA_DIR: dataDir,
    NOVA_BACKEND_PORT: String(backendPort), NOVA_ELECTRON_CDP_ENABLED: 'true',
    NOVA_ELECTRON_CDP_PORT: String(debugPort), NOVA_CDP_ENABLED: 'false', NOVA_CDP_LAUNCH_ENABLED: 'false' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PORTABLE_EXECUTABLE_DIR;
  if (defaultInstalledData) delete env.NOVA_DATA_DIR;
  child = spawn(executable, executableArg ? [] : [repo], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  evidence.pid = child.pid;
  child.on('error', error => { evidence.spawnError = error.message; });
  child.once('exit', (code, signal) => { childExit = { code, signal }; });
  child.stdout.on('data', chunk => fs.appendFileSync(path.join(outputDir, 'stdout.log'), chunk));
  child.stderr.on('data', chunk => fs.appendFileSync(path.join(outputDir, 'stderr.log'), chunk));
  evidence.config = await until(() => json(`${evidence.backendUrl}/api/nova/config`));
  evidence.queueStatus = await json(`${evidence.backendUrl}/api/nova/queue-status`);
  const target = await until(async () => (await json(`http://127.0.0.1:${debugPort}/json/list`)).find(item => item.type === 'page' && item.url === `${evidence.backendUrl}/`));
  client = await connect(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  evidence.renderer = await until(async () => {
    const response = await client.call('Runtime.evaluate', { expression: `JSON.stringify({readyState:document.readyState,title:document.title,url:location.href,loaderPresent:!!document.getElementById('app-boot-loader'),text:document.body.innerText,desktopVersions:window.novaDesktop?.versions,requireType:typeof require,processType:typeof process})`, returnByValue: true });
    const value = JSON.parse(response.result.value);
    return value.readyState === 'complete' && !value.loaderPresent && value.text.length > 30 && value.desktopVersions?.electron ? value : null;
  });
  assert.match(evidence.renderer.title, /Nova/);
  assert.equal(evidence.renderer.requireType, 'undefined');
  assert.equal(evidence.renderer.processType, 'undefined');
  assert.equal(client.exceptions.length, 0, JSON.stringify(client.exceptions));
  evidence.rendererExceptions = client.exceptions;
  // Browser.close asks Electron to close its actual browser/window, then app.quit runs.
  await client.call('Browser.close').catch(error => { evidence.closeResponse = error.message; });
  assert.ok(await waitForExit(), 'Electron failed to exit after Browser.close');
  assert.equal(childExit.code, 0, JSON.stringify(childExit));
  evidence.childExit = childExit;
  const dbPath = path.join(dataDir, 'nova-tasks.sqlite');
  assert.ok(fs.statSync(dbPath).size > 0);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  evidence.database = { path: dbPath, bytes: fs.statSync(dbPath).size,
    quickCheck: db.pragma('quick_check'), sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get(),
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() };
  assert.ok(evidence.database.tables.some(table => table.name === 'tasks'));
  assert.deepEqual(evidence.database.quickCheck, [{ quick_check: 'ok' }]);
  db.close();
  evidence.status = 'passed';
})().catch(error => {
  evidence.status = 'failed';
  evidence.error = error.stack;
  process.exitCode = 1;
}).finally(async () => {
  client?.close();
  if (child && !childExit) { child.kill(); await waitForExit(5000); evidence.forcedCleanup = true; }
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
});
