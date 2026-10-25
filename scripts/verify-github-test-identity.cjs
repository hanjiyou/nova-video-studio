'use strict';
// Independent packaged Electron harness: no Nova entry, backend, window or network.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { REPOSITORY, verifyDirectory, hashFile } = require('./lib/windows-update.cjs');
async function main(argv) {
  assert.equal(argv.length, 2, 'Expected verified GitHub test directory and new evidence directory.');
  const directory = path.resolve(argv[0]), output = path.resolve(argv[1]);
  const evidenceRoot = path.join(REPOSITORY, 'release-updates/local-verification');
  assert.equal(path.dirname(output), evidenceRoot, 'Evidence must be a new direct child of local-verification.');
  assert.match(path.basename(output), /^github-test-[A-Za-z0-9.-]+-identity$/);
  assert.equal(fs.existsSync(output), false, 'Evidence output must not exist.');
  const { plan } = await verifyDirectory(directory);
  assert.equal(plan.profile, 'github-test');
  fs.mkdirSync(output);
  const application = path.join(directory, 'win-unpacked/resources/app.asar');
  const pkg = JSON.parse(asar.extractFile(application, 'package.json'));
  const harness = path.join(output, 'harness-runtime');
  const dist = path.dirname(require('electron'));
  fs.cpSync(dist, harness, { recursive: true, filter: source => path.basename(source) !== 'default_app.asar' });
  const executable = path.join(harness, 'Nova Studio Identity Harness.exe');
  fs.renameSync(path.join(harness, 'electron.exe'), executable);
  const source = path.join(output, 'harness-source'); fs.mkdirSync(source);
  for (const name of ['update-identity.cjs', 'runtime.cjs']) fs.writeFileSync(path.join(source, name), asar.extractFile(application, 'desktop/' + name));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ ...pkg, main: 'identity.cjs' }));
  const entry = [
    "'use strict';",
    "const { app } = require('electron'); const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');",
    "const pkg = require('./package.json'); const { resolvePackageSystemUserData } = require('./update-identity.cjs'); const { resolveDataPolicy } = require('./runtime.cjs');",
    "try {",
    "const initialName = app.getName(); const version = app.getVersion(); const packaged = app.isPackaged;",
    "const systemUserData = resolvePackageSystemUserData({ app, pkg }); const data = resolveDataPolicy({ env: {}, systemUserData });",
    "assert.equal(packaged, true); assert.equal(initialName, pkg.productName); assert.equal(app.getName(), pkg.productName); assert.equal(version, pkg.version);",
    "assert.equal(data.mode, 'system'); assert.equal(data.directory, path.join(app.getPath('appData'), 'Nova Studio GitHub Test')); assert.notEqual(path.basename(data.directory), 'nova-image');",
    "const destination = process.argv.find(s => s.startsWith('--identity-result=')).slice('--identity-result='.length);",
    "fs.writeFileSync(destination, JSON.stringify({ schemaVersion: 1, initialName, name: app.getName(), version, packaged, appId: pkg.novaUpdate.appId, updaterCacheDirName: pkg.novaUpdate.updaterCacheDirName, feed: pkg.novaUpdate.feed, signatureMode: pkg.novaUpdate.signature.mode, data, noNovaMain: true, noBackend: true, noNetwork: true, noInstallation: true }, null, 2) + String.fromCharCode(10), { flag: 'wx' });",
    "app.exit(0);",
    "} catch { app.exit(1); }",
  ].join('\n');
  fs.writeFileSync(path.join(source, 'identity.cjs'), entry);
  await asar.createPackage(source, path.join(harness, 'resources/app.asar'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NOVA_DATA_DIR; delete env.PORTABLE_EXECUTABLE_DIR;
  const results = [];
  for (let index = 1; index <= 2; index++) {
    const destination = path.join(output, 'launch-' + index + '.json');
    const child = spawnSync(executable, ['--identity-result=' + destination], { cwd: harness, env, windowsHide: true, timeout: 30000, stdio: 'ignore' });
    assert.equal(child.error, undefined, 'Identity harness failed to launch.'); assert.equal(child.status, 0, 'Identity harness failed its assertions.');
    results.push(JSON.parse(fs.readFileSync(destination, 'utf8')));
  }
  assert.deepEqual(results[0], results[1], 'Fresh process must retain the same identity and system data directory.');
  const summary = { schemaVersion: 1, source: { directory, appAsarSha512: await hashFile(application), version: plan.version }, results, checks: { twoFreshPackagedProcesses: true, packageProductNameUsedByElectron: true, sameSystemDirectoryWithoutOverride: true, productionIdentityAndRuntimeModulesFromVerifiedAsar: true, noNovaEntryOrBusinessServices: true, noGitHubRequests: true, noInstallGateBypass: true }, limitation: 'Independent harness proves package identity/system data selection only. No A installation, actual Nova startup, updater network or A-to-B restart was performed.' };
  fs.writeFileSync(path.join(output, 'identity-summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
