'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectOpenChatCutRuntime, createOpenChatCutServiceEnvironment, hashFile, SHARED_FFMPEG_PATH } = require('./openchatcut-runtime.cjs');
const commit = '7fa4b7903e7ebecf832a36249f0c0c755200cc17';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-occ-precheck-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = { sourceDirectory: 'third_party/openchatcut', distDirectory: 'dist', serviceEntry: 'desktop-dist/nova-service.mjs', buildReceipt: 'desktop-dist/nova-integration.json', engineCommit: commit, nodeMajor: 24, requiredPackages: ['react', '@remotion/renderer'] };
  const sourceRoot = path.join(root, configuration.sourceDirectory);
  const write = (relative, body) => { const file = path.join(sourceRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  write('package.json', '{"type":"module"}'); write('package-lock.json', '{"lockfileVersion":3}');
  for (const name of configuration.requiredPackages) write(`node_modules/${name}/package.json`, '{}');
  write('dist/index.html', '<html>native editor</html>'); write(configuration.serviceEntry, 'export const native=true;');
  const receipt = { schemaVersion: 1, engineCommit: commit, serviceSha256: hashFile(path.join(sourceRoot, configuration.serviceEntry)), indexSha256: hashFile(path.join(sourceRoot, 'dist/index.html')), lockSha256: hashFile(path.join(sourceRoot, 'package-lock.json')) };
  write(configuration.buildReceipt, JSON.stringify(receipt));
  const inspect = (overrides = {}) => inspectOpenChatCutRuntime({ repositoryRoot: root, configuration, nodeVersion: '24.14.0', readRevision: () => commit, readGitlink: () => commit, ...overrides });
  return { root, configuration, sourceRoot, inspect, write, receipt };
}
test('precheck validates the pinned source and exact current build receipt', t => {
  const f = fixture(t); const result = f.inspect();
  assert.equal(result.available, true); assert.equal(result.engineCommit, commit);
  assert.equal(result.servicePath, path.join(f.sourceRoot, 'desktop-dist/nova-service.mjs'));
  assert.equal(result.workingDirectory, f.sourceRoot);
});
test('precheck refuses version drift, unsupported Node and unprepared packaged runtime', t => {
  const f = fixture(t);
  assert.equal(f.inspect({ readRevision: () => '0'.repeat(40) }).code, 'EDITOR_VERSION_MISMATCH');
  assert.equal(f.inspect({ readGitlink: () => '0'.repeat(40) }).code, 'EDITOR_VERSION_MISMATCH');
  assert.equal(f.inspect({ nodeVersion: '22.0.0' }).code, 'EDITOR_NODE_UNSUPPORTED');
  assert.equal(f.inspect({ packaged: true }).code, 'EDITOR_RUNTIME_NOT_PACKAGED');
});
test('build file or lock drift invalidates the receipt instead of silently using stale output', t => {
  const f = fixture(t); f.write('dist/index.html', '<html>changed</html>');
  assert.equal(f.inspect().code, 'EDITOR_BUILD_INVALID');
  f.write('dist/index.html', '<html>native editor</html>'); f.write('package-lock.json', '{}');
  assert.equal(f.inspect().code, 'EDITOR_BUILD_INVALID');
});
test('missing dependencies and artifacts have distinguishable safe errors', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.sourceRoot, 'node_modules/react/package.json'));
  assert.equal(f.inspect().code, 'EDITOR_DEPENDENCIES_MISSING');
  f.write('node_modules/react/package.json', '{}'); fs.unlinkSync(path.join(f.sourceRoot, f.configuration.serviceEntry));
  assert.equal(f.inspect().code, 'EDITOR_BUILD_MISSING');
});
test('source configuration cannot escape the workspace and raw errors do not leak', t => {
  const f = fixture(t);
  const outside = f.inspect({ configuration: { ...f.configuration, sourceDirectory: '../private' } });
  assert.equal(outside.code, 'EDITOR_PRECHECK_FAILED'); assert.equal(outside.sourceRoot, undefined);
  const error = f.inspect({ readRevision() { throw new Error('secret=C:/private/key'); } });
  assert.equal(error.code, 'EDITOR_PRECHECK_FAILED'); assert.ok(!JSON.stringify(error).includes('secret'));
});
test('service environment isolates credentials, user homes and injected Node options', t => {
  const f = fixture(t);
  const env = createOpenChatCutServiceEnvironment({ dataDirectory: f.root, distDirectory: path.join(f.sourceRoot, 'dist'), parentEnv: { PATH: 'safe-path', SYSTEMROOT: 'safe-system', OPENAI_API_KEY: 'never-copy', ANTHROPIC_API_KEY: 'never-copy', NOVA_RELEASE_TOKEN: 'never-copy', NODE_OPTIONS: '--require hostile.cjs', HOME: 'real-home', USERPROFILE: 'real-profile', APPDATA: 'real-appdata', OPENCHATCUT_DATA_DIR: 'real-store' } });
  assert.equal(env.PATH, 'safe-path');
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NOVA_RELEASE_TOKEN', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
  assert.equal(env.HOME, path.join(f.root, 'private-home')); assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.OPENCHATCUT_DATA_DIR, f.root); assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(env.APPDATA.startsWith(f.root)); assert.ok(env.XDG_CONFIG_HOME.startsWith(f.root));
});
test('service environment rejects caller-provided relative roots and malformed profile IDs', () => {
  assert.throws(() => createOpenChatCutServiceEnvironment({ dataDirectory: 'relative' }), /absolute/);
  assert.throws(() => createOpenChatCutServiceEnvironment({ dataDirectory: os.tmpdir(), profileId: '../other' }), /UUIDv4/);
});

function packagedFixture(t) {
  const f = fixture(t);
  const resourcesPath = path.join(f.root, 'resources');
  const runtimeRoot = path.join(resourcesPath, 'openchatcut');
  fs.cpSync(f.sourceRoot, runtimeRoot, { recursive: true });
  const configuration = { ...f.configuration, packagedDirectory: 'openchatcut', packagedRequiredPackages: f.configuration.requiredPackages };
  const manifest = { schemaVersion: 1, profile: 'local-preview', engineCommit: commit, receiptSha256: hashFile(path.join(runtimeRoot, configuration.buildReceipt)), packageSha256: hashFile(path.join(runtimeRoot, 'package.json')) };
  fs.writeFileSync(path.join(runtimeRoot, 'nova-runtime.json'), JSON.stringify(manifest));
  const inspect = overrides => inspectOpenChatCutRuntime({ configuration, resourcesPath, packaged: true, nodeVersion: '24.18.1', readRevision() { throw new Error('Git must not run in a package'); }, readGitlink() { throw new Error('Git must not run in a package'); }, ...overrides });
  return { ...f, runtimeRoot, resourcesPath, configuration, manifest, inspect };
}

test('packaged preview resolves only shipped resources without Git or a development checkout', t => {
  const f = packagedFixture(t);
  const result = f.inspect();
  assert.equal(result.available, true);
  assert.equal(result.servicePath, path.join(f.runtimeRoot, f.configuration.serviceEntry));
  assert.equal(result.workingDirectory, f.runtimeRoot);
  assert.equal(f.inspect({ nodeVersion: '22.0.0' }).code, 'EDITOR_NODE_UNSUPPORTED');
  assert.equal(f.inspect({ resourcesPath: path.join(f.root, 'empty') }).code, 'EDITOR_RUNTIME_NOT_PACKAGED');
});

test('packaged preview rejects stale service, package metadata, manifest version and missing dependencies', t => {
  const f = packagedFixture(t);
  const service = path.join(f.runtimeRoot, f.configuration.serviceEntry);
  const original = fs.readFileSync(service);
  fs.writeFileSync(service, 'changed');
  assert.equal(f.inspect().code, 'EDITOR_BUILD_INVALID');
  fs.writeFileSync(service, original);
  const packagePath = path.join(f.runtimeRoot, 'package.json');
  fs.appendFileSync(packagePath, '\n');
  assert.equal(f.inspect().code, 'EDITOR_BUILD_INVALID');
  fs.writeFileSync(packagePath, '{"type":"module"}');
  const manifestPath = path.join(f.runtimeRoot, 'nova-runtime.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...f.manifest, engineCommit: '0'.repeat(40) }));
  assert.equal(f.inspect().code, 'EDITOR_VERSION_MISMATCH');
  fs.writeFileSync(manifestPath, JSON.stringify(f.manifest));
  fs.unlinkSync(path.join(f.runtimeRoot, 'node_modules/react/package.json'));
  assert.equal(f.inspect().code, 'EDITOR_DEPENDENCIES_MISSING');
});

test('packaged preview rejects path traversal in resource configuration', t => {
  const f = packagedFixture(t);
  assert.equal(f.inspect({ configuration: { ...f.configuration, packagedDirectory: '../private' } }).code, 'EDITOR_PRECHECK_FAILED');
});

test('deduplicated packaged FFmpeg must exist at the fixed path and match the audited bytes', t => {
  const f = packagedFixture(t);
  const shared = path.join(f.resourcesPath, SHARED_FFMPEG_PATH);
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, 'audited-media-fixture');
  const record = { sha256: hashFile(shared), bytes: fs.statSync(shared).size };
  fs.writeFileSync(path.join(f.runtimeRoot, 'nova-runtime.json'), JSON.stringify({ ...f.manifest, sharedFfmpeg: record }));
  const inspect = () => f.inspect({ readMediaAudit: () => ({ 'win32-x64': { sha256: record.sha256 } }) });
  assert.equal(inspect().available, true);
  assert.equal(inspect().ffmpegPath, shared);
  fs.writeFileSync(shared, 'tampered');
  assert.equal(inspect().code, 'EDITOR_BUILD_INVALID');
  fs.unlinkSync(shared);
  assert.equal(inspect().code, 'EDITOR_DEPENDENCIES_MISSING');
  fs.writeFileSync(shared, 'audited-media-fixture');
  const duplicate = path.join(f.runtimeRoot, 'node_modules/ffmpeg-static/ffmpeg.exe');
  fs.mkdirSync(path.dirname(duplicate), { recursive: true }); fs.writeFileSync(duplicate, 'duplicate');
  assert.equal(inspect().code, 'EDITOR_BUILD_INVALID');
});

test('service receives only the validated explicit media path, never inherited media overrides', t => {
  const f = fixture(t);
  const inherited = { OPENCHATCUT_FFMPEG: 'hostile-media', FFMPEG_BIN: 'hostile-binary', FFMPEG_PATH: 'hostile-path' };
  const clean = createOpenChatCutServiceEnvironment({ dataDirectory: f.root, parentEnv: inherited });
  for (const name of Object.keys(inherited)) assert.equal(clean[name], undefined);
  const media = path.join(f.root, 'audited-ffmpeg.exe');
  const env = createOpenChatCutServiceEnvironment({ dataDirectory: f.root, parentEnv: inherited, ffmpegPath: media });
  assert.equal(env.OPENCHATCUT_FFMPEG, media); assert.equal(env.FFMPEG_BIN, media); assert.equal(env.FFMPEG_PATH, undefined);
  assert.throws(() => createOpenChatCutServiceEnvironment({ dataDirectory: f.root, ffmpegPath: 'relative.exe' }), /absolute ffmpegPath/);
});
