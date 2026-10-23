'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { resolveBackendPort } = require('../desktop/runtime.cjs');
const { PRESET_MODELS } = require('../backend/connections/capabilities');
const repo = path.resolve(__dirname, '..'), output = path.resolve(process.argv[2] || path.join(repo, 'temp/t04-native-' + Date.now())), data = path.join(output, 'data');
assert.ok(!fs.existsSync(output), 'Fresh profile required');
fs.mkdirSync(data, { recursive: true });
const requests = [];
const server = http.createServer((req, res) => { requests.push({ method: req.method, path: req.url, authorized: ['Bearer synthetic-windows-safe-storage-A', 'Bearer synthetic-windows-safe-storage-B', 'Bearer synthetic-windows-safe-storage-C'].includes(req.headers.authorization) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: PRESET_MODELS.map(id => ({ id })) })); });
async function phase(number) {
    const env = { ...process.env, NODE_ENV: 'production', NOVA_DATA_DIR: data, NOVA_CONNECTION_EVIDENCE: output, NOVA_CONNECTION_PHASE: String(number), NOVA_CONNECTION_TEST_BASE: 'http://127.0.0.1:' + server.address().port + '/v1', NOVA_BACKEND_PORT: String(await resolveBackendPort(0)) };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'NOVA_ELECTRON_CDP_ENABLED', 'NOVA_AGENT_ENABLED', 'NOVA_CDP_ENABLED', 'NOVA_CDP_LAUNCH_ENABLED'])
        delete env[key];
    const child = spawn(require('electron'), [path.join(repo, 'scripts/electron-connections-test-entry.cjs')], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of ['stdout', 'stderr'])
        child[stream].on('data', chunk => fs.appendFileSync(path.join(output, 'phase-' + number + '-' + stream + '.log'), chunk));
    const timer = setTimeout(() => child.kill(), 30000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    clearTimeout(timer);
    assert.equal(code, 0, 'Strict native process exit');
    const evidence = JSON.parse(fs.readFileSync(path.join(output, 'phase-' + number + '.json'), 'utf8'));
    assert.equal(evidence.status, 'passed', evidence.error);
    console.log(JSON.stringify(evidence, null, 2));
    const db = new Database(path.join(data, 'nova-tasks.sqlite'), { readonly: true });
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
    for (const key of ['synthetic-windows-safe-storage-A', 'synthetic-windows-safe-storage-B', 'synthetic-windows-safe-storage-C']) {
        assert.equal(fs.readFileSync(path.join(data, 'nova-tasks.sqlite')).includes(Buffer.from(key)), false);
        for (const stream of ['stdout', 'stderr']) {
            const file = path.join(output, 'phase-' + number + '-' + stream + '.log');
            if (fs.existsSync(file))
                assert.equal(fs.readFileSync(file, 'utf8').includes(key), false);
        }
    }
}
(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await phase(1); await phase(2); assert.ok(requests.length > 0 && requests.every(request => request.method === 'GET' && request.path === '/v1/models' && request.authorized)); fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2) + '\n'); })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server.closeAllConnections(); server.close(); });
