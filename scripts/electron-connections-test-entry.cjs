'use strict';
// Test-only real Windows safeStorage/IPC wrapper. No provider generation calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { app, BrowserWindow, safeStorage } = require('electron');
const output = process.env.NOVA_CONNECTION_EVIDENCE, phase = Number(process.env.NOVA_CONNECTION_PHASE);
assert.ok(output && [1, 2].includes(phase) && process.env.NOVA_DATA_DIR && process.env.NOVA_CONNECTION_TEST_BASE);
const KEY_A = 'synthetic-windows-safe-storage-A', KEY_B = 'synthetic-windows-safe-storage-B', KEY_C = 'synthetic-windows-safe-storage-C';
const evidence = { startedAt: new Date().toISOString(), phase, platform: process.platform, providerRequests: 'read-only loopback GET /v1/models only', checks: {} };
const check = (name, value) => { assert.ok(value, name); evidence.checks[name] = true; };
let primary;
async function until(fn) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        const result = await fn();
        if (result)
            return result;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Readiness timeout');
}
async function run(window) {
    const evaluate = expression => window.webContents.executeJavaScript(expression, true);
    await until(() => evaluate('document.readyState === "complete" && !document.getElementById("app-boot-loader") && !!window.novaDesktop?.saveConnection'));
    const backend = require('../backend/server'), origin = new URL(window.webContents.getURL()).origin;
    const stateFile = path.join(output, 'state.json');
    let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    const ipc = async (method, input) => evaluate('window.novaDesktop.' + method + '(' + JSON.stringify(input) + ')');
    const request = (route, options = {}) => evaluate('fetch(' + JSON.stringify(route) + ',' + JSON.stringify(options) + ').then(async r=>({status:r.status,body:await r.json()}))');
    const db = new Database(path.join(process.env.NOVA_DATA_DIR, 'nova-tasks.sqlite'));
    try {
        check('real OS encryption is available', safeStorage.isEncryptionAvailable() && process.platform === 'win32');
        if (phase === 1) {
            const first = await ipc('saveConnection', { displayName: '共用图片视频连接', baseUrl: process.env.NOVA_CONNECTION_TEST_BASE, provider: 'openai-compatible', apiKey: KEY_A });
            check('actual preload IPC saves encrypted connection', first.ok && first.connection.credentialState === 'ready');
            state.connectionId = first.connection.connectionId;
            state.firstVersion = first.connection.connectionVersionId;
            check('host resolves original credential without exposing it to renderer', backend.connections.getAuth(state.firstVersion).apiKey === KEY_A);
            const checkResult = await request('/api/nova/connections/' + state.connectionId + '/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionVersionId: state.firstVersion }) });
            check('actual renderer performs read-only connection check without text model', checkResult.status === 200 && checkResult.body.connection.validationState === 'verified' && checkResult.body.models.some(model => model.model === 'gpt-image-2.5-flare' && model.visibility === 'visible'));
            check('loopback visibility does not acquire OpenSosen history', checkResult.body.capabilities.every(cap => cap.evidenceLevel === 'unverified'));
            const second = await ipc('saveConnection', { connectionId: state.connectionId, expectedVersionId: state.firstVersion, apiKey: KEY_B, defaultImageModel: 'gpt-image-2.5-flare', defaultVideoModel: 'grok-imagine-video-1.5-6s' });
            check('new save creates a distinct immutable version', second.ok && second.connection.connectionVersionId !== state.firstVersion);
            state.secondVersion = second.connection.connectionVersionId;
            state.taskId = randomUUID();
            const asset = backend.storage.importBuffer(fs.readFileSync(path.join(__dirname, '../backend/test/fixtures/workbench-v1/reference-a.png')), { mimeType: 'image/png' });
            state.assetId = asset.assetId;
            db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(state.taskId, 'processing', 'plugin', JSON.stringify({ upstreamTaskId: 'synthetic-preserved-upstream-id', model: 'grok-imagine-video-1.5-6s' }), new Date().toISOString());
            backend.storage.setTaskSnapshot(state.taskId, { contractVersion: 1, connectionVersionId: state.firstVersion, mode: 'video.single_reference', model: 'grok-imagine-video-1.5-6s', prompt: '中文\n"原句"', parameters: { seconds: 6 }, inputAssets: [{ assetId: state.assetId, position: 0, role: 'reference' }] });
            const other = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '../desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
            await other.loadURL(origin);
            const denied = await other.webContents.executeJavaScript('window.novaDesktop.saveConnection(' + JSON.stringify({ apiKey: KEY_C }) + ')');
            check('other webContents cannot save credentials', denied.code === 'IPC_FORBIDDEN');
            other.destroy();
            state.firstOrigin = origin;
        }
        else {
            check('restart changes backend port', origin !== state.firstOrigin);
            const current = await request('/api/nova/connections/current');
            check('encrypted current connection survives native restart', current.body.connection.connectionVersionId === state.secondVersion && current.body.connection.credentialState === 'ready');
            check('old task keeps original destination and credential', backend.connections.getAuth(state.firstVersion).apiKey === KEY_A && backend.connections.getAuth(state.secondVersion).apiKey === KEY_B);
            const row = db.prepare('SELECT connection_version_id,input_snapshot_json,request_json FROM tasks WHERE id=?').get(state.taskId);
            check('old task snapshot and upstream ID survive unchanged', row.connection_version_id === state.firstVersion && JSON.parse(row.input_snapshot_json).inputAssets[0].assetId === state.assetId && JSON.parse(row.request_json).upstreamTaskId === 'synthetic-preserved-upstream-id');
            db.prepare('UPDATE credential_entries SET ciphertext=? WHERE id=(SELECT credential_ref FROM connection_versions WHERE id=?)').run(Buffer.from('owned synthetic invalid ciphertext'), state.secondVersion);
            const broken = await request('/api/nova/connections/current');
            check('real OS decryption failure returns recoverable summary', broken.body.connection.hasCredential && broken.body.connection.credentialState === 'unavailable');
            const repaired = await ipc('saveConnection', { connectionId: state.connectionId, expectedVersionId: state.secondVersion, apiKey: KEY_C });
            check('fresh credential repairs current connection with a new version', repaired.ok && repaired.connection.credentialState === 'ready' && repaired.connection.connectionVersionId !== state.secondVersion);
            let oldFailure;
            try {
                backend.connections.getAuth(state.secondVersion);
            }
            catch (error) {
                oldFailure = error.code;
            }
            check('broken old version never falls forward to replacement key', oldFailure === 'CREDENTIAL_UNAVAILABLE');
            const cleared = await ipc('clearConnectionCredential', { connectionId: state.connectionId, expectedVersionId: repaired.connection.connectionVersionId });
            check('actual IPC clear removes current credential', cleared.ok && !cleared.connection.hasCredential && cleared.connection.credentialState === 'missing');
            let revoked;
            try {
                backend.connections.getAuth(state.firstVersion);
            }
            catch (error) {
                revoked = error.code;
            }
            check('clear revokes historical credentials without redirecting old task', revoked === 'CREDENTIAL_REQUIRED');
            check('clear preserves task/upstream ID and shared asset', db.prepare('SELECT connection_version_id FROM tasks WHERE id=?').get(state.taskId).connection_version_id === state.firstVersion && backend.storage.readAsset(state.assetId).bytes.length > 0);
        }
        const summaries = await request('/api/nova/connections');
        check('HTTP summaries expose no key/ciphertext/credentialRef', ![KEY_A, KEY_B, KEY_C, 'credentialRef', 'ciphertext'].some(value => JSON.stringify(summaries).includes(value)));
        check('renderer browser storage contains no credentials', await evaluate('[...Array(localStorage.length)].every((_,i)=>!localStorage.getItem(localStorage.key(i)).includes("synthetic-windows-safe-storage"))'));
        const entries = db.prepare('SELECT ciphertext FROM credential_entries WHERE ciphertext IS NOT NULL').all();
        check('database stores only OS ciphertext', entries.every(row => ![KEY_A, KEY_B, KEY_C].some(key => row.ciphertext.includes(Buffer.from(key)))));
        check('schema version 3 applied', db.prepare('SELECT max(version) n FROM schema_migrations').get().n === 3);
        evidence.connectionVersionIds = [state.firstVersion, state.secondVersion];
        evidence.origin = origin;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    }
    finally {
        db.close();
    }
}
app.on('browser-window-created', (_event, window) => {
    if (primary)
        return;
    primary = window;
    window.webContents.once('did-finish-load', () => run(window).then(() => { evidence.status = 'passed'; }).catch(error => { evidence.status = 'failed'; evidence.error = error.stack; }).finally(() => { evidence.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'phase-' + phase + '.json'), JSON.stringify(evidence, null, 2) + '\n'); console.log('T04 native connections ' + phase + ' ' + evidence.status); app.quit(); }));
});
require('../desktop/main.cjs');
