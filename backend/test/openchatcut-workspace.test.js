'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-editor-workspace-'));
  const dbPath = path.join(directory, 'tasks.sqlite'); let db = new Database(dbPath);
  await migrateDatabase({ db, dbPath });
  const makeStore = () => createWorkbenchStore({ db, rootDirectory: path.join(directory, 'storage') });
  t.after(() => { db.close(); const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 }); });
  return { store: makeStore(), reopen() { db.close(); db = new Database(dbPath); return makeStore(); } };
}
test('editor navigation and settings return survive reopening without adding a generation mode', async t => {
  const fixture = await setup(t);
  const saved = fixture.store.putSetting('workspace', { value: { activePage: 'editor', returnPage: 'editor', activeMode: 'video.dual_reference', recentVideoTaskLimit: 20 } });
  assert.equal(saved.value.activePage, 'editor');
  const reopened = fixture.reopen(); assert.deepEqual(reopened.getSetting('workspace').value, saved.value);
  assert.throws(() => reopened.putSetting('workspace', { value: { activeMode: 'editor' } }), error => error.code === 'INVALID_SETTING_VALUE');
});
test('editor page support keeps the workspace schema narrow and revision conflicts leave records unchanged', async t => {
  const { store } = await setup(t);
  const saved = store.putSetting('workspace', { value: { activePage: 'settings', returnPage: 'editor' }, expectedRevision: 0 });
  for (const value of [{ activePage: 'unknown' }, { returnPage: 'settings' }, { activePage: 'editor', url: 'https://outside.invalid' }, { activePage: 'editor', apiKey: 'synthetic' }]) {
    assert.throws(() => store.putSetting('workspace', { value }), error => ['INVALID_SETTING_VALUE', 'INVALID_STORAGE_INPUT'].includes(error.code));
  }
  assert.throws(() => store.putSetting('workspace', { value: { activePage: 'editor' }, expectedRevision: 0 }), error => error.code === 'SETTING_REVISION_CONFLICT');
  assert.deepEqual(store.getSetting('workspace'), saved);
});
