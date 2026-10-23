'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { BASE_SCHEMA } = require('../backend/storage/migrations');
const { resolveBackendPort } = require('../desktop/runtime.cjs');
const repo = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(repo, 'temp/t03-native-' + Date.now()));
const data = path.join(output, 'data');
assert.ok(!fs.existsSync(output), 'Fresh output directory required');
fs.mkdirSync(data, { recursive: true });
const sources = ['参考 image.png', '参考 image.jpg'].map(name => path.join(output, name));
fs.copyFileSync(path.join(repo, 'backend/test/fixtures/workbench-v1/reference-a.png'), sources[0]);
fs.copyFileSync(path.join(repo, 'backend/test/fixtures/workbench-v1/reference-single.jpg'), sources[1]);
const state = { taskId: randomUUID(), sources, prompt: '中文第一句\n"保留对白"\r\n第二句' };
fs.writeFileSync(path.join(output, 'state.json'), JSON.stringify(state, null, 2) + '\n');
const db = new Database(path.join(data, 'nova-tasks.sqlite'));
db.exec(BASE_SCHEMA);
db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(state.taskId, 'failed', 'plugin', JSON.stringify({ model: 'fixture-model', prompt: state.prompt }), '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z');
db.close();
async function phase(number) {
    const env = { ...process.env, NODE_ENV: 'production', NOVA_DATA_DIR: data, NOVA_STORAGE_EVIDENCE: output, NOVA_STORAGE_TEST_PHASE: String(number), NOVA_BACKEND_PORT: String(await resolveBackendPort(0)) };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'NOVA_ELECTRON_CDP_ENABLED', 'NOVA_AGENT_ENABLED', 'NOVA_CDP_ENABLED', 'NOVA_CDP_LAUNCH_ENABLED'])
        delete env[key];
    const child = spawn(require('electron'), [path.join(repo, 'scripts/electron-storage-test-entry.cjs')], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of ['stdout', 'stderr'])
        child[stream].on('data', chunk => fs.appendFileSync(path.join(output, 'phase-' + number + '-' + stream + '.log'), chunk));
    const timeout = setTimeout(() => child.kill(), 30000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    clearTimeout(timeout);
    assert.equal(code, 0, 'Electron clean exit');
    const evidence = JSON.parse(fs.readFileSync(path.join(output, 'phase-' + number + '.json'), 'utf8'));
    assert.equal(evidence.status, 'passed', evidence.error);
    console.log(JSON.stringify(evidence, null, 2));
    const check = new Database(path.join(data, 'nova-tasks.sqlite'), { readonly: true });
    assert.equal(check.pragma('quick_check', { simple: true }), 'ok');
    check.close();
}
(async () => { await phase(1); await phase(2); })().catch(error => { console.error(error); process.exitCode = 1; });
