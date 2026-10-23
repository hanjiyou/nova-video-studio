'use strict';
// Actual Electron main/preload/IPC with a fresh synthetic profile; no external requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, safeStorage } = require('electron');
const output = process.env.NOVA_TASK_EVIDENCE, phase = Number(process.env.NOVA_TASK_PHASE), key = 'synthetic-t05-windows-key';
assert.ok(output && process.env.NOVA_DATA_DIR && process.env.NOVA_TASK_TEST_BASE && [1, 2].includes(phase));
const evidence = { phase, platform: process.platform, checks: {}, startedAt: new Date().toISOString(), scope: 'Actual Electron source runtime; loopback synthetic image POST only; no product UI acceptance' };
const check = (name, value) => { assert.ok(value, name); evidence.checks[name] = true; };
async function until(fn) { const end = Date.now() + 15000; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Native task readiness timeout'); }
let primary;
async function run(window) {
    const evaluate = expression => window.webContents.executeJavaScript(expression, true);
    await until(() => evaluate('document.readyState==="complete" && !document.getElementById("app-boot-loader") && !!window.novaDesktop?.saveConnection'));
    const request = (route, options = {}) => evaluate('fetch(' + JSON.stringify(route) + ',' + JSON.stringify(options) + ').then(async r=>({status:r.status,body:await r.json()}))');
    const post = (route, body = {}) => request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const stateFile = path.join(output, 'state.json'); let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    const backend = require('../backend/server');
    check('real Windows OS encryption available', process.platform === 'win32' && safeStorage.isEncryptionAvailable());
    check('T05 task service is live in actual desktop main', Boolean(backend.tasks));
    if (phase === 1) {
        const saved = await evaluate('window.novaDesktop.saveConnection(' + JSON.stringify({ baseUrl: process.env.NOVA_TASK_TEST_BASE, apiKey: key }) + ')');
        check('actual narrow IPC encrypts synthetic task credential', saved.ok && saved.connection.credentialState === 'ready'); state.connection = saved.connection;
        state.payload = { localRequestId: randomUUID(), connectionVersionId: state.connection.connectionVersionId, mode: 'text-to-image', model: 'gpt-image-2', prompt: '本地合成验证\n"原句"', parallelCount: 1, outputSize: 'auto', aspectRatio: 'auto', images: [] };
        const first = await post('/api/nova/tasks', state.payload); check('renderer creates durable task without a raw key in HTTP', first.status === 202); state.first = first.body.taskId;
        await until(async () => (await request('/api/nova/tasks/' + state.first)).body.status === 'submitting');
        check('dispatch boundary is durable before held POST finishes', backend.storage.events(state.first).some(event => event.type === 'dispatch_started'));
        const second = await post('/api/nova/tasks', { ...state.payload, localRequestId: randomUUID() }); state.second = second.body.taskId;
        check('one generation reservation queues the next intent', second.status === 202 && (await request('/api/nova/tasks/' + state.second)).body.status === 'local_queued');
        const third = await post('/api/nova/tasks', { ...state.payload, localRequestId: randomUUID() }); state.third = third.body.taskId;
        check('queued cancellation uses actual renderer API', (await post('/api/nova/tasks/' + state.third + '/cancel-queued')).body.task.status === 'local_cancelled');
        check('same localRequestId returns the same task', (await post('/api/nova/tasks', state.payload)).body.taskId === state.first);
        state.origin = new URL(window.webContents.getURL()).origin;
    } else {
        check('restart uses another local port', new URL(window.webContents.getURL()).origin !== state.origin);
        const first = (await request('/api/nova/tasks/' + state.first)).body, second = (await request('/api/nova/tasks/' + state.second)).body;
        check('interrupted submit becomes unknown without losing its local identity', first.status === 'submission_unknown' && first.localRequestId === state.payload.localRequestId);
        check('unknown submission retains generation reservation and billing notice', first.generationReserved && first.remoteMayContinue && first.schedulingNotice.includes('计费'));
        check('undispatched queue waits for explicit continue', second.status === 'local_queued' && second.requiresContinue);
        check('local cancellation survives actual restart', (await request('/api/nova/tasks/' + state.third)).body.status === 'local_cancelled');
        check('old version decrypts through real safeStorage after restart', backend.connections.getAuth(state.connection.connectionVersionId).apiKey === key);
        check('lost ACK replay remains deduplicated after native restart', (await post('/api/nova/tasks', state.payload)).body.taskId === state.first);
        check('continue does not bypass an unknown generation reservation', (await post('/api/nova/tasks/' + state.second + '/continue-queued')).status === 200 && (await request('/api/nova/tasks/' + state.second)).body.status === 'local_queued');
        const history = await request('/api/nova/storage/tasks'); check('task/history DTOs contain no raw credential or path', !JSON.stringify({ first, second, history }).includes(key) && !JSON.stringify(history).includes(process.env.NOVA_DATA_DIR));
    }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n'); evidence.origin = new URL(window.webContents.getURL()).origin;
}
app.on('browser-window-created', (_event, window) => { if (primary) return; primary = window; window.webContents.once('did-finish-load', () => run(window).then(() => { evidence.status = 'passed'; }).catch(error => { evidence.status = 'failed'; evidence.error = error.stack; }).finally(() => { evidence.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'phase-' + phase + '.json'), JSON.stringify(evidence, null, 2) + '\n'); app.quit(); })); });
require('../desktop/main.cjs');
