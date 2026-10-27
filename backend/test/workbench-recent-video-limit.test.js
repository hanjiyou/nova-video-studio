'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
const { start } = require('./support/desktop-http-runtime.cjs');
const navigation = { activeMode: 'video.single_reference', activePage: 'settings', returnPage: 'video', wideMode: true };
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-recent-limit-')), dbPath = path.join(directory, 'tasks.sqlite');
  const db = new Database(dbPath); await migrateDatabase({ db, dbPath });
  t.after(() => { if (db.open) db.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { directory, dbPath, db, store: createWorkbenchStore({ db, rootDirectory: path.join(directory, 'storage') }) };
}

test('workspace accepts old values and 1..100 recent video counts, preserves merged navigation and survives reopening', async t => {
  const f = await setup(t); assert.equal(f.store.getSetting('workspace').value, null);
  let saved = f.store.putSetting('workspace', { value: navigation, expectedRevision: 0 });
  for (const limit of [1, 6, 10, 20, 100]) {
    saved = f.store.putSetting('workspace', { value: { ...saved.value, recentVideoTaskLimit: limit }, expectedRevision: saved.revision });
    assert.deepEqual(saved.value, { ...navigation, recentVideoTaskLimit: limit });
  }
  f.db.close();
  const reopened = new Database(f.dbPath);
  try { const store = createWorkbenchStore({ db: reopened, rootDirectory: path.join(f.directory, 'storage') }); assert.deepEqual(store.getSetting('workspace'), saved); }
  finally { reopened.close(); }
});

test('workspace rejects non-integer, out-of-range and non-number counts without changing revision or navigation', async t => {
  const { store } = await setup(t);
  const saved = store.putSetting('workspace', { value: { ...navigation, recentVideoTaskLimit: 20 }, expectedRevision: 0 });
  for (const invalid of [null, '', '20', 'abc', 0, -1, 101, 1.5, NaN, Infinity, true, [], {}]) {
    assert.throws(() => store.putSetting('workspace', { value: { ...saved.value, recentVideoTaskLimit: invalid }, expectedRevision: saved.revision }), { code: 'INVALID_SETTING_VALUE' });
    assert.deepEqual(store.getSetting('workspace'), saved);
  }
  assert.throws(() => store.putSetting('workspace', { value: { ...saved.value, recentVideoTaskLimit: 10 }, expectedRevision: 0 }), { code: 'SETTING_REVISION_CONFLICT' });
  assert.deepEqual(store.getSetting('workspace'), saved);
});

test('desktop HTTP persists count20 across restart, enforces invalid/conflict boundary and serves 20 video records', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-recent-limit-http-'));
  let runtime = await start(directory);
  t.after(async () => { await runtime.stop(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const route = '/api/nova/storage/settings/workspace';
  const put = (value, revision) => runtime.request(route, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, expectedRevision: revision }) });
  assert.equal((await (await runtime.request(route)).json()).setting.value, null);
  const response = await put({ ...navigation, recentVideoTaskLimit: 20 }, 0); assert.equal(response.status, 200);
  const saved = (await response.json()).setting;
  for (const invalid of ['', null, '20', 1.5, 0, 101]) {
    const rejected = await put({ ...saved.value, recentVideoTaskLimit: invalid }, saved.revision); assert.equal(rejected.status, 400); assert.equal((await rejected.json()).code, 'INVALID_SETTING_VALUE');
  }
  assert.equal((await put({ ...saved.value, recentVideoTaskLimit: 10 }, 0)).status, 409);
  const db = new Database(path.join(directory, 'tasks.sqlite'));
  try { const insert = db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,expires_at) VALUES(?,?,?,?,?,?)'); for (let index = 0; index < 25; index++) insert.run(randomUUID(), 'completed', 'video.text', JSON.stringify({ prompt: 'synthetic ' + index, model: 'synthetic' }), new Date(index * 1000).toISOString(), null); }
  finally { db.close(); }
  const list = await (await runtime.request('/api/nova/storage/tasks?kind=video&limit=20&scope=workbench')).json(); assert.equal(list.items.length, 20); assert.equal(list.total, 25);
  await runtime.stop(); runtime = await start(directory);
  assert.deepEqual((await (await runtime.request(route)).json()).setting, saved);
});
