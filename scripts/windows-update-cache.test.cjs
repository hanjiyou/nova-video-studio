'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { validateInstallerCache, prepareInstallerCache, BASELINE_FILE } = require('../desktop/update-cache.cjs');
const { compileCacheHarness } = require('./lib/windows-update-cache-harness.cjs');
const appId = 'com.novaimage.studio.github-test', version = '8.0.0';
const digest = data => createHash('sha512').update(data).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cache-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('nova-cache-fixture-'));
    // All files are synthetic. Reset only the known deliberately read-only file.
    for (const f of ['installer.next.exe', 'installer.exe']) { const p = path.join(root, appId + '-updater', f); if (fs.existsSync(p)) fs.chmodSync(p, 0o666); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cacheDirectory = path.join(root, appId + '-updater'); fs.mkdirSync(cacheDirectory);
  const data = randomBytes(128 * 1024), source = path.join(root, 'synthetic-installer.exe');
  fs.writeFileSync(source, data);
  const options = { cacheDirectory, appId, version };
  const baseline = () => {
    fs.writeFileSync(path.join(cacheDirectory, 'installer.exe'), data);
    fs.writeFileSync(path.join(cacheDirectory, BASELINE_FILE), JSON.stringify({ schemaVersion: 1, appId, version, sha512: digest(data) }));
  };
  return { root, cacheDirectory, data, source, options, baseline };
}
test('missing marker never trusts legacy package, pending package or another channel', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cacheDirectory, 'installer.exe'), f.data);
  fs.mkdirSync(path.join(f.cacheDirectory, 'pending')); fs.writeFileSync(path.join(f.cacheDirectory, 'pending/installer.exe'), f.data);
  const foreign = path.join(f.root, 'nova-image-updater'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'installer.exe'), 'foreign');
  assert.deepEqual(await prepareInstallerCache(f.options), { trusted: false, reason: 'baseline_missing' });
  assert.equal(fs.readFileSync(path.join(foreign, 'installer.exe'), 'utf8'), 'foreign');
});
test('valid baseline is read-only validated; prepare invalidates only premature root map', async t => {
  const f = fixture(t); f.baseline();
  fs.writeFileSync(path.join(f.cacheDirectory, 'current.blockmap'), 'downloaded-but-not-installed-map');
  fs.mkdirSync(path.join(f.cacheDirectory, 'pending')); fs.writeFileSync(path.join(f.cacheDirectory, 'pending/current.blockmap'), 'pending');
  assert.deepEqual(await validateInstallerCache(f.options), { trusted: true, reason: null });
  assert.ok(fs.existsSync(path.join(f.cacheDirectory, 'current.blockmap')));
  assert.deepEqual(await prepareInstallerCache(f.options), { trusted: true, reason: null });
  assert.equal(fs.existsSync(path.join(f.cacheDirectory, 'current.blockmap')), false);
  assert.equal(fs.readFileSync(path.join(f.cacheDirectory, 'pending/current.blockmap'), 'utf8'), 'pending');
});
test('identity, version, corrupt installer, malformed record and absent package fail closed', async t => {
  const f = fixture(t); f.baseline();
  for (const [change, reason] of [[{ appId: 'other' }, 'identity_mismatch'], [{ version: '7.0.0' }, 'version_mismatch'], [{ extra: true }, 'baseline_invalid']]) {
    fs.writeFileSync(path.join(f.cacheDirectory, BASELINE_FILE), JSON.stringify({ schemaVersion: 1, appId, version, sha512: digest(f.data), ...change }));
    assert.equal((await prepareInstallerCache(f.options)).reason, reason);
  }
  f.baseline(); fs.writeFileSync(path.join(f.cacheDirectory, 'installer.exe'), 'corrupt');
  assert.equal((await prepareInstallerCache(f.options)).reason, 'installer_corrupt');
  f.baseline(); fs.unlinkSync(path.join(f.cacheDirectory, 'installer.exe'));
  assert.equal((await prepareInstallerCache(f.options)).reason, 'installer_missing');
  assert.equal((await prepareInstallerCache({ ...f.options, cacheDirectory: f.root })).reason, 'cache_invalid');
});
test('directory-shaped map and junction-shaped cache are rejected without touching target', async t => {
  const f = fixture(t); f.baseline(); fs.mkdirSync(path.join(f.cacheDirectory, 'current.blockmap'));
  assert.equal((await prepareInstallerCache(f.options)).reason, 'map_unusable');
  const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep.txt'), 'keep');
  const junction = path.join(f.root, 'linked', appId + '-updater'); fs.mkdirSync(path.dirname(junction));
  fs.symlinkSync(foreign, junction, 'junction');
  assert.equal((await prepareInstallerCache({ ...f.options, cacheDirectory: junction })).reason, 'cache_invalid');
  assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'keep');
  fs.unlinkSync(junction);
});
test('real compiled NSIS macros establish baseline, overwrite, clear old map and survive failed copy', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cacheDirectory, 'installer.next.exe'), 'stale stage');
  const h = compileCacheHarness({ directory: path.join(f.root, 'compiled'), ...f.options, source: f.source });
  h.execute();
  assert.deepEqual(await validateInstallerCache(f.options), { trusted: true, reason: null });
  assert.deepEqual(fs.readFileSync(path.join(f.cacheDirectory, 'installer.exe')), f.data);
  fs.writeFileSync(path.join(f.cacheDirectory, 'current.blockmap'), 'old map');
  const next = randomBytes(64 * 1024); fs.writeFileSync(f.source, next); h.execute();
  assert.deepEqual(fs.readFileSync(path.join(f.cacheDirectory, 'installer.exe')), next);
  assert.equal(fs.existsSync(path.join(f.cacheDirectory, 'current.blockmap')), false);
  assert.deepEqual(await validateInstallerCache(f.options), { trusted: true, reason: null });
  fs.unlinkSync(f.source); h.execute();
  assert.equal((await validateInstallerCache(f.options)).reason, 'baseline_missing');
});
test('real compiled NSIS copying failure cannot publish stale baseline', async t => {
  const f = fixture(t); f.baseline();
  const h = compileCacheHarness({ directory: path.join(f.root, 'failed-copy'), ...f.options, source: f.source, copyFailure: true });
  h.execute();
  assert.equal((await validateInstallerCache(f.options)).reason, 'baseline_missing');
});
test('real NSIS uninstall compilation excludes cache operations and same source keeps valid baseline', async t => {
  const f = fixture(t); f.baseline();
  const uninstall = compileCacheHarness({ directory: path.join(f.root, '卸载 compile space'), ...f.options, source: f.source, uninstaller: true });
  uninstall.execute();
  assert.deepEqual(await validateInstallerCache(f.options), { trusted: true, reason: null });
  const sameSource = compileCacheHarness({ directory: path.join(f.root, '同源 cache space'), ...f.options, source: path.join(f.cacheDirectory, 'installer.exe') });
  sameSource.execute();
  assert.deepEqual(await validateInstallerCache(f.options), { trusted: true, reason: null });
  assert.deepEqual(fs.readFileSync(path.join(f.cacheDirectory, 'installer.exe')), f.data);
});
test('baseline checks detect directory replacement while opening installer', async t => {
  const f = fixture(t); f.baseline();
  const original = fs.promises.open;
  const moved = f.cacheDirectory + '-replaced';
  let changed = false;
  fs.promises.open = async function(filename, ...args) {
    if (!changed && filename === path.join(f.cacheDirectory, 'installer.exe')) {
      changed = true; fs.renameSync(f.cacheDirectory, moved); fs.mkdirSync(f.cacheDirectory);
      fs.writeFileSync(filename, f.data);
    }
    return original.call(this, filename, ...args);
  };
  try { assert.equal((await validateInstallerCache(f.options)).reason, 'cache_changed'); }
  finally { fs.promises.open = original; }
});
test('concurrent prepare calls remain bounded and do not inspect another channel', async t => {
  const f = fixture(t); f.baseline(); fs.writeFileSync(path.join(f.cacheDirectory, 'current.blockmap'), 'stale');
  const results = await Promise.all([prepareInstallerCache(f.options), prepareInstallerCache(f.options)]);
  assert.ok(results.every(r => r.trusted));
});