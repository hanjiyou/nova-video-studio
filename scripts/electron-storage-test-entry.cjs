'use strict';
// Test-only native file selection/restart wrapper. Loads the actual desktop main.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const output = process.env.NOVA_STORAGE_EVIDENCE;
const phase = Number(process.env.NOVA_STORAGE_TEST_PHASE);
assert.ok(output && [1, 2].includes(phase) && process.env.NOVA_DATA_DIR);
const evidence = { startedAt: new Date().toISOString(), phase, providerRequests: 'none', checks: {} };
let primary;
const check = (name, value) => { assert.ok(value, name); evidence.checks[name] = true; };
const until = async (fn) => { const end = Date.now() + 15000; while (Date.now() < end) {
    const value = await fn();
    if (value)
        return value;
    await new Promise(resolve => setTimeout(resolve, 100));
} throw new Error('Native storage readiness timeout'); };
async function run(window) {
    const contents = window.webContents;
    const evaluate = expression => contents.executeJavaScript(expression, true);
    await until(() => evaluate('document.readyState === "complete" && !document.getElementById("app-boot-loader") && !!window.novaDesktop'));
    const origin = new URL(contents.getURL()).origin;
    evidence.origin = origin;
    const request = async (route, options = {}) => evaluate('fetch(' + JSON.stringify(route) + ',' + JSON.stringify({ ...options, headers: { 'content-type': 'application/json', ...options.headers }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }) + ').then(async r=>({status:r.status,body:await r.json()}))');
    const stateFile = path.join(output, 'state.json');
    const backend = require('../backend/server');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (phase === 1) {
        let dialogCalls = 0;
        dialog.showOpenDialog = async () => { dialogCalls++; return { canceled: false, filePaths: state.sources }; };
        const imported = await evaluate('window.novaDesktop.importReferenceAssets()');
        check('native IPC imports selected PNG/JPEG', imported.ok && imported.assets.length === 2 && dialogCalls === 1);
        check('asset DTO contains no source paths', state.sources.every(source => !JSON.stringify(imported).includes(source)));
        state.assets = imported.assets;
        for (const source of state.sources)
            fs.renameSync(source, source + '.moved');
        const inputAssets = state.assets.map((asset, position) => ({ assetId: asset.assetId, role: 'reference', position }));
        const draft = await request('/api/nova/storage/drafts/video.dual_reference', { method: 'PUT', body: { prompt: state.prompt, model: 'fixture-model', parameters: { duration: 6, aspectRatio: '16:9' }, inputAssets, expectedRevision: 0 } });
        check('actual renderer saves ordered draft', draft.status === 200 && draft.body.draft.inputAssets.every((asset, index) => asset.assetId === state.assets[index].assetId));
        backend.storage.setTaskSnapshot(state.taskId, { contractVersion: 1, mode: 'video.dual_reference', model: 'fixture-model', prompt: state.prompt, parameters: { duration: 6 }, inputAssets });
        check('renderer saves persistent setting', (await request('/api/nova/storage/settings/theme', { method: 'PUT', body: { value: 'dark', expectedRevision: 0 } })).status === 200);
        const other = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '../desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
        await other.loadURL(origin);
        check('other webContents cannot invoke import IPC', (await other.webContents.executeJavaScript('window.novaDesktop.importReferenceAssets()')).code === 'IPC_FORBIDDEN' && dialogCalls === 1);
        other.destroy();
        state.firstOrigin = origin;
        state.schemaHistory = backend.storage.events(state.taskId);
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    }
    else {
        check('restart uses a different origin', origin !== state.firstOrigin);
        const draft = await request('/api/nova/storage/drafts/video.dual_reference');
        check('Chinese/newline draft survives native restart', draft.body.draft.prompt === state.prompt);
        check('input order survives changed port', draft.body.draft.inputAssets.every((asset, index) => asset.assetId === state.assets[index].assetId));
        check('persistent setting survives changed port', (await request('/api/nova/storage/settings/theme')).body.setting.value === 'dark');
        const history = await request('/api/nova/storage/tasks');
        check('expired legacy TTL cannot erase desktop history', history.body.total === 1 && history.body.items[0].localTaskId === state.taskId && history.body.items[0].status === 'failed');
        const acknowledged = await request('/api/nova/tasks/' + state.taskId + '/ack', { method: 'POST' });
        check('ACK retains task and shared assets', acknowledged.status === 200 && (await request('/api/nova/storage/tasks')).body.total === 1 && backend.storage.countReferences(state.assets[0].assetId) === 2);
    }
    for (const asset of state.assets) {
        const hash = await evaluate('fetch(' + JSON.stringify(asset.previewUrl) + ').then(r=>r.arrayBuffer()).then(b=>crypto.subtle.digest("SHA-256",b)).then(b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join(""))');
        check('managed bytes survive source move ' + asset.kind + ' ' + asset.mimeType, hash === asset.sha256);
    }
    const backups = fs.readdirSync(path.join(process.env.NOVA_DATA_DIR, 'backups')).filter(name => name.endsWith('.sqlite'));
    check('schema upgrades once without extra restart backup', backups.length === 1);
    evidence.assetIds = state.assets.map(asset => asset.assetId);
    evidence.schemaBackups = backups.length;
}
app.on('browser-window-created', (_event, window) => {
    if (primary)
        return;
    primary = window;
    window.webContents.once('did-finish-load', () => run(window).then(() => { evidence.status = 'passed'; }).catch(error => { evidence.status = 'failed'; evidence.error = error.stack; }).finally(() => {
        evidence.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(output, 'phase-' + phase + '.json'), JSON.stringify(evidence, null, 2) + '\n');
        console.log('T03 native storage ' + phase + ' ' + evidence.status);
        app.quit();
    }));
});
require('../desktop/main.cjs');
