'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { resolveBackendPort } = require('../desktop/runtime.cjs');
const root = path.resolve(__dirname, '..'), output = path.resolve(process.argv[2] || path.join(root, 'temp/t05-native-' + Date.now())), data = path.join(output, 'data');
assert.ok(!fs.existsSync(output), 'A fresh explicit profile is required'); fs.mkdirSync(data, { recursive: true });
const calls = [], key = 'synthetic-t05-windows-key';
const server = http.createServer(async (req, _res) => { for await (const chunk of req) void chunk; calls.push({ method: req.method, path: req.url, authorized: req.headers.authorization === 'Bearer ' + key }); /* Deliberately no ACK: the actual desktop closes and aborts its pending POST. */ });
async function phase(number) {
    const env = { ...process.env, NODE_ENV: 'production', NOVA_DATA_DIR: data, NOVA_TASK_EVIDENCE: output, NOVA_TASK_PHASE: String(number), NOVA_TASK_TEST_BASE: 'http://127.0.0.1:' + server.address().port + '/v1', NOVA_BACKEND_PORT: String(await resolveBackendPort(0)) };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'NOVA_ELECTRON_CDP_ENABLED', 'NOVA_AGENT_ENABLED', 'NOVA_CDP_ENABLED', 'NOVA_CDP_LAUNCH_ENABLED']) delete env[name];
    const child = spawn(require('electron'), [path.join(root, 'scripts/electron-tasks-test-entry.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => fs.appendFileSync(path.join(output, 'phase-' + number + '-' + stream + '.log'), bytes));
    const timer = setTimeout(() => child.kill(), 30000); const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); clearTimeout(timer);
    assert.equal(code, 0, 'Strict actual Electron exit'); const report = JSON.parse(fs.readFileSync(path.join(output, 'phase-' + number + '.json'), 'utf8')); assert.equal(report.status, 'passed', report.error);
    console.log(JSON.stringify(report)); const db = new Database(path.join(data, 'nova-tasks.sqlite'), { readonly: true });
    try { assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.prepare('SELECT max(version) n FROM schema_migrations').get().n, 4); } finally { db.close(); }
    for (const stream of ['stdout', 'stderr']) { const file = path.join(output, 'phase-' + number + '-' + stream + '.log'); if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, 'utf8').includes(key), false); }
}
(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await phase(1); assert.equal(calls.length, 1); await phase(2); assert.deepEqual(calls, [{ method: 'POST', path: '/v1/images/generations', authorized: true }]); fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(calls, null, 2) + '\n'); })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server.closeAllConnections(); server.close(); });
