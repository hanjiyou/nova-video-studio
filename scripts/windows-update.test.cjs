'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const yaml = require('js-yaml');
const asar = require('@electron/asar');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
const { createUpdateInfoTasks, writeUpdateInfoFiles } = require('app-builder-lib/out/publish/updateInfoBuilder');
const { Platform } = require('app-builder-lib');
const { Arch } = require('builder-util');
const { readPolicy, stableVersion, compareVersions, localFeed, makePlan, planForRecord, verifyDirectory, builderConfiguration, verifyArtifacts, publisherMatches } = require('./lib/windows-update.cjs');
const release = require('./release-windows-update.cjs');
const { argumentsFrom, runBuild } = require('./build-windows-update.cjs');

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-update-fixture-'));
  t.after(() => {
    const absolute = path.resolve(directory), temp = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute), temp);
    assert.ok(path.basename(absolute).startsWith('nova-update-fixture-'));
    assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false);
    fs.rmSync(absolute, { recursive: true });
  });
  return directory;
}

const input = { profile: 'local-test', version: '3.5.0', testFeedUrl: 'http://127.0.0.1:18888/' };
function inspection(plan) {
  return () => [{ status: 'NotSigned', subject: '', fileVersion: plan.windowsVersion, productVersion: plan.version }, { status: 'NotSigned', subject: '', fileVersion: plan.windowsVersion, productVersion: plan.windowsVersion }];
}

async function fixture(directory, plan) {
  fs.mkdirSync(directory, { recursive: true });
  const installer = path.join(directory, plan.artifactName);
  // Inert fixture bytes, never executed; real builder generates their blockmap/manifest.
  fs.writeFileSync(installer, Buffer.concat([Buffer.from('MZ'), randomBytes(90000)]));
  const updateInfo = await buildBlockMap(installer, 'gzip', installer + '.blockmap');
  const packager = { platform: Platform.WINDOWS, appInfo: { version: plan.version }, platformSpecificBuildOptions: {}, config: { releaseInfo: { releaseNotes: 'Offline fixture' } }, info: { metadata: { dependencies: { 'electron-updater': '6.8.11' } } } };
  const tasks = await createUpdateInfoTasks({ file: installer, updateInfo, packager, target: { outDir: directory }, arch: Arch.x64 }, [plan.feed]);
  await writeUpdateInfoFiles(tasks, { emitArtifactCreated: async () => {} });
  const resources = path.join(directory, 'win-unpacked/resources');
  fs.mkdirSync(resources, { recursive: true });
  const source = path.join(directory, 'fixture-asar-source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'nova-image', version: plan.version, dependencies: { 'electron-updater': '6.8.11' }, novaUpdate: plan.metadata, ...(plan.source ? { novaBuild: plan.source } : {}) }));
  await asar.createPackage(source, path.join(resources, 'app.asar'));
  fs.writeFileSync(path.join(resources, 'app-update.yml'), yaml.dump({ ...plan.feed, updaterCacheDirName: plan.updaterCacheDirName, ...(plan.signature.mode === 'authenticode' ? { publisherName: plan.signature.publisherNames } : {}) }));
  fs.writeFileSync(path.join(directory, 'win-unpacked', plan.productName + '.exe'), 'MZ inert app fixture');
  return { installer, manifest: path.join(directory, 'latest.yml'), resources };
}

function mutateManifest(file, change) {
  const value = yaml.load(fs.readFileSync(file, 'utf8'));
  change(value);
  fs.writeFileSync(file, yaml.dump(value));
}

test('single mapping separates old four-part packaging, app SemVer, Windows version and test/release identities', () => {
  const a = makePlan(input), b = makePlan({ ...input, version: '3.5.1' });
  assert.equal(a.windowsVersion, '3.5.0.0');
  assert.equal(b.windowsVersion, '3.5.1.0');
  assert.equal(a.tag, 'v3.5.0');
  assert.equal(compareVersions(a.version, b.version), -1);
  assert.equal(require('../package.json').version, '3.4.0');
  assert.equal(a.appId, 'com.novaimage.studio.offline-test.followup-20261024');
  assert.notEqual(a.appId, readPolicy().identities.release.appId);
  assert.equal(a.runtimeReady, false);
});

for (const value of ['3.4.0.18', '03.5.0', 'v3.5.0', '3.5.0+2', '3.5.0-beta.1', '65536.0.0', '../3.5.0']) {
  test('reject unsupported update version ' + value, () => assert.throws(() => stableVersion(value)));
}

for (const value of [undefined, 'https://example.com/', 'http://localhost:18888/', 'http://127.0.0.1.evil.test:18888/', 'http://user:secret@127.0.0.1:18888/', 'http://127.0.0.1:18888/?token=x', 'http://127.0.0.1:18888/feed']) {
  test('reject absent/untrusted generic test feed ' + String(value).replace('user:secret@', ''), () => assert.throws(() => localFeed(value)));
}

test('release remains gated by signing, fixed public GitHub feed cannot be overridden by test URL', () => {
  assert.throws(() => makePlan({ profile: 'release' }), /signing\/publisher/);
  const policy = readPolicy();
  policy.signing = { status: 'approved', publisherNames: ['CN=Fixture, O=Fixture'] };
  const release = makePlan({ profile: 'release' }, policy);
  assert.deepEqual(release.feed, { provider: 'github', owner: 'hanjiyou', repo: 'nova-video-studio', private: false, channel: 'latest', releaseType: 'release' });
  assert.notEqual(release.updaterCacheDirName, makePlan(input).updaterCacheDirName);
  assert.throws(() => makePlan({ profile: 'release', testFeedUrl: input.testFeedUrl }, policy), /test feed/);
  policy.githubFeed = null;
  assert.throws(() => makePlan({ profile: 'release' }, policy), /GitHub feed/);
});

test('build config keeps edited version resources, test signing disabled, exact metadata/feed and differential NSIS', () => {
  const plan = makePlan(input), config = builderConfiguration(plan, 'C:/inert-attempt');
  assert.equal(config.extraMetadata.version, plan.version);
  assert.equal(config.buildVersion, plan.windowsVersion);
  assert.equal(config.win.signAndEditExecutable, true);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.forceCodeSigning, false);
  assert.deepEqual(config.publish, [plan.feed]);
});

test('CLI rejects unknown/repeated/missing arguments', () => {
  assert.throws(() => argumentsFrom(['--publish', 'always']));
  assert.throws(() => argumentsFrom(['--version']));
  assert.throws(() => argumentsFrom(['--profile', 'local-test', '--profile', 'release']));
});

test('two builder-generated fixture manifests/blockmaps parse and validate in pinned updater', async t => {
  const root = sandbox(t);
  for (const version of ['3.5.0', '3.5.1']) {
    const plan = makePlan({ ...input, version });
    const directory = path.join(root, version);
    await fixture(directory, plan);
    const result = await verifyArtifacts(directory, plan, { inspectWindowsFiles: inspection(plan) });
    assert.equal(result.version, version);
    assert.ok(result.blockmap.chunks > 0);
    assert.equal(result.publication, 'not-published');
  }
});

const failures = [
  ['missing installer', ({ installer }) => fs.unlinkSync(installer), /ENOENT/],
  ['missing blockmap', ({ installer }) => fs.unlinkSync(installer + '.blockmap'), /ENOENT/],
  ['tampered installer', ({ installer }) => fs.appendFileSync(installer, 'bad'), /size/],
  ['wrong manifest hash', ({ manifest }) => mutateManifest(manifest, m => m.files[0].sha512 = 'bad'), /SHA512/],
  ['mixed manifest version', ({ manifest }) => mutateManifest(manifest, m => m.version = '3.5.1'), /version\/files/],
  ['absolute manifest URL', ({ manifest }) => mutateManifest(manifest, m => m.files[0].url = 'https://invalid.example/a.exe'), /path/],
  ['wrong manifest path', ({ manifest }) => mutateManifest(manifest, m => m.path = '../bad.exe'), /path/],
  ['same-length tampered blockmap', ({ installer }) => { const map = JSON.parse(gunzipSync(fs.readFileSync(installer + '.blockmap'))); map.files[0].checksums[0] = 'AAAAAAAAAAAAAAAAAAAAAAAA'; fs.writeFileSync(installer + '.blockmap', gzipSync(JSON.stringify(map))); }, /Blockmap checksum/],
  ['wrong packaged version', ({ resources }) => { fs.writeFileSync(path.join(resources, 'app.asar'), 'bad'); }, /./],
  ['changed packaged feed', ({ resources }) => { const p = path.join(resources, 'app-update.yml'); const cfg = yaml.load(fs.readFileSync(p, 'utf8')); cfg.url = 'http://127.0.0.1:19999/'; fs.writeFileSync(p, yaml.dump(cfg)); }, /feed/],
  ['unexpected token field', ({ resources }) => { fs.appendFileSync(path.join(resources, 'app-update.yml'), 'token: inert-fixture-only\n'); }, /unexpected fields/],
];
for (const [label, mutate, error] of failures) test('reject ' + label, async t => {
  const directory = sandbox(t), plan = makePlan(input);
  const files = await fixture(directory, plan);
  mutate(files);
  await assert.rejects(verifyArtifacts(directory, plan, { inspectWindowsFiles: inspection(plan) }), error);
});

test('reject unsigned-test signature errors and inconsistent PE versions', async t => {
  const directory = sandbox(t), plan = makePlan(input);
  await fixture(directory, plan);
  await assert.rejects(verifyArtifacts(directory, plan, { inspectWindowsFiles: () => [{ ...inspection(plan)()[0], status: 'HashMismatch' }, inspection(plan)()[1]] }), /signature status/);
  await assert.rejects(verifyArtifacts(directory, plan, { inspectWindowsFiles: () => [{ status: 'NotSigned' }, { status: 'NotSigned', fileVersion: '43.4.0.0', productVersion: '43.4.0' }] }), /version resources/);
});

test('check-only creates nothing; success is atomic and version output cannot be reused', async t => {
  const root = sandbox(t), plan = makePlan(input, readPolicy(), root);
  const deps = { makePlan: () => plan, tools: () => ({ npm: 'inert-npm', builder: 'inert-builder' }), execute: async args => { if (args[0] === 'inert-builder') { assert.deepEqual(args.slice(-2), ['--publish', 'never']); const config = JSON.parse(fs.readFileSync(args[2], 'utf8')); await fixture(config.directories.output, plan); } }, verifyArtifacts: (directory, p) => verifyArtifacts(directory, p, { inspectWindowsFiles: inspection(p) }) };
  await runBuild({ ...input, checkOnly: true }, deps);
  assert.equal(fs.existsSync(plan.root), false);
  await runBuild(input, deps);
  assert.ok(fs.existsSync(path.join(plan.output, 'latest.yml')));
  assert.ok(fs.existsSync(path.join(plan.output, 'update-summary.json')));
  assert.equal(fs.existsSync(path.join(plan.root, '.build.lock')), false);
  await assert.rejects(runBuild(input, deps), /not be overwritten/);
});

test('build failure retains logs and allows same version retry; lock prevents parallel mutation', async t => {
  const root = sandbox(t), plan = makePlan(input, readPolicy(), root);
  const deps = { makePlan: () => plan, tools: () => ({}), execute: async () => { throw new Error('inert frontend failure'); } };
  await assert.rejects(runBuild(input, deps), /frontend failure/);
  assert.equal(fs.existsSync(plan.output), false);
  const attempts = fs.readdirSync(path.dirname(plan.output));
  assert.equal(attempts.length, 1);
  assert.match(fs.readFileSync(path.join(path.dirname(plan.output), attempts[0], 'build.log'), 'utf8'), /inert frontend failure/);
  assert.equal(fs.existsSync(path.join(plan.root, '.build.lock')), false);
  fs.writeFileSync(path.join(plan.root, '.build.lock'), 'inert lock');
  await assert.rejects(runBuild(input, deps), /holds the lock/);
  assert.equal(fs.readFileSync(path.join(plan.root, '.build.lock'), 'utf8'), 'inert lock');
});

test('publisher matching follows stable updater CN/DN semantics, including field order', () => {
  assert.equal(publisherMatches('CN=Nova, O=Example, C=CN', 'Nova'), true);
  assert.equal(publisherMatches('CN=Nova, O=Example, C=CN', 'C=CN, O=Example, CN=Nova'), true);
  assert.equal(publisherMatches('CN=Nova, O=Example, C=CN', 'CN=Nova, O=Other'), false);
  assert.equal(publisherMatches('CN=Other, O=Example', 'Nova'), false);
});

test('only explicit new local-test builds may enable test runtime, never release signing', () => {
  const plan = makePlan({ ...input, version: '3.5.2', enableTestRuntime: true });
  assert.equal(plan.runtimeReady, true);
  assert.equal(readPolicy().runtimeReady, false);
  assert.equal(readPolicy().signing.status, 'pending');
  assert.equal(makePlan({ ...input, version: '3.5.2' }).runtimeReady, false);
  assert.throws(() => makePlan({ ...input, enableTestRuntime: true }), /3.5.2/);
  assert.throws(() => makePlan({ profile: 'release', version: '3.5.2', enableTestRuntime: true }), /local-test/);
  assert.equal(argumentsFrom(['--enable-test-runtime']).enableTestRuntime, true);
  assert.throws(() => argumentsFrom(['--enable-test-runtime', '--enable-test-runtime']));
});

test('history permits only runtime boolean difference; record cannot change fixed policy', () => {
  const old = makePlan(input);
  const record = { ...input, metadata: old.metadata };
  const policy = readPolicy(); policy.runtimeReady = true;
  assert.equal(planForRecord(record, policy).runtimeReady, false);
  for (const [key, value] of [['appId', 'other.id'], ['minimumUpdatableVersion', '0.0.0'], ['feed', { ...old.feed, token: 'inert' }], ['signature', { mode: 'authenticode', publisherNames: ['Other'] }], ['runtimeReady', 'false']]) {
    assert.throws(() => planForRecord({ ...record, metadata: { ...old.metadata, [key]: value } }, policy));
  }
  policy.identities['local-test'].appId = 'other.id';
  assert.throws(() => planForRecord(record, policy), /identity/);
});

test('history compares actual packaged metadata and complete saved summary', async t => {
  const directory = sandbox(t), plan = makePlan({ ...input, version: '3.5.2', enableTestRuntime: true });
  await fixture(directory, plan);
  fs.writeFileSync(path.join(directory, 'update-plan.json'), JSON.stringify({ ...input, version: plan.version, metadata: plan.metadata }));
  const summary = await verifyArtifacts(directory, plan, { inspectWindowsFiles: inspection(plan) });
  fs.writeFileSync(path.join(directory, 'update-summary.json'), JSON.stringify(summary));
  assert.equal((await verifyDirectory(directory, { inspectWindowsFiles: inspection(plan) })).summary.runtimeReady, true);
  fs.writeFileSync(path.join(directory, 'update-plan.json'), JSON.stringify({ ...input, version: plan.version, metadata: { ...plan.metadata, runtimeReady: false } }));
  await assert.rejects(verifyDirectory(directory, { inspectWindowsFiles: inspection(plan) }), /Packaged version/);
  fs.writeFileSync(path.join(directory, 'update-plan.json'), JSON.stringify({ ...input, version: plan.version, metadata: plan.metadata }));
  fs.writeFileSync(path.join(directory, 'update-summary.json'), JSON.stringify({ ...summary, sha512: 'bad' }));
  await assert.rejects(verifyDirectory(directory, { inspectWindowsFiles: inspection(plan) }), /Saved summary/);
});

test('release defaults to local dry-run and lists unresolved gates', () => {
  assert.deepEqual(release.args(['--directory', 'inert']), { directory: 'inert', phase: 'prepare', execute: false });
  assert.equal(release.args(['--directory', 'inert', '--phase', 'publish']).execute, false);
  assert.throws(() => release.args(['--directory', 'inert', '--execute']), /always/);
  assert.throws(() => release.args(['--directory', 'inert', '--repo', 'other/repo']));
  const pending = release.blockers(makePlan(input));
  assert.ok(pending.some(s => s.includes('Unsigned')));
  assert.ok(pending.some(s => s.includes('ffmpegCorrespondingSource')));
  assert.ok(pending.some(s => s.includes('isolatedInstalledUpdate')));
});

test('release cannot change GitHub source even with approved signing fixture', () => {
  const policy = readPolicy();
  policy.signing = { status: 'approved', publisherNames: ['Fixture'] };
  policy.githubFeed.repo = 'other-repo';
  assert.throws(() => makePlan({ profile: 'release' }, policy), /fixed approved/);
});

test('formal source record must equal the source embedded in the signed application package', async t => {
  const directory = sandbox(t), policy = readPolicy();
  policy.signing = { status: 'approved', publisherNames: ['Fixture Publisher'] }; policy.runtimeReady = true;
  const plan = makePlan({ profile: 'release', version: '3.5.4' }, policy); plan.source = { commit: 'a'.repeat(40), clean: true };
  await fixture(directory, plan);
  const inspectWindowsFiles = () => inspection(plan)().map(value => ({ ...value, status: 'Valid', subject: 'CN=Fixture Publisher' }));
  const summary = await verifyArtifacts(directory, plan, { inspectWindowsFiles });
  assert.deepEqual(summary.source, plan.source);
  const mismatch = { ...plan, source: { commit: 'b'.repeat(40), clean: true } };
  await assert.rejects(verifyArtifacts(directory, mismatch, { inspectWindowsFiles }), /Packaged clean source commit/);
});
