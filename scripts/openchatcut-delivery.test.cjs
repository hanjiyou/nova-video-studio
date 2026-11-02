'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fingerprintSubmodule, prepareSource, preparePackage } = require('./openchatcut-delivery.cjs');
const { fingerprint } = require('./deliver.cjs');
const URL = 'https://github.com/hanjiyou/OpenChatCut.git', SOURCE = 'third_party/openchatcut';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, SOURCE); fs.mkdirSync(source, { recursive: true });
  const git = args => execFileSync('git', ['-c', 'safe.directory=' + source.replaceAll('\\', '/'), '-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(source, 'source.txt'), 'original'); git(['add', 'source.txt']); git(['commit', '-qm', 'base']); git(['remote', 'add', 'origin', URL]);
  const config = { sourceDirectory: SOURCE, repository: URL, engineCommit: git(['rev-parse', 'HEAD']) };
  fs.mkdirSync(path.join(root, 'config')); fs.writeFileSync(path.join(root, 'config/openchatcut-runtime.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "' + SOURCE + '"]\npath = ' + SOURCE + '\nurl = ' + URL + '\n');
  return { root, source, git, config };
}
test('review fingerprints the exact clean gitlink and rejects other directories', t => {
  const { root } = fixture(t);
  assert.match(fingerprint(root, SOURCE), /^[a-f0-9]{64}$/);
  assert.equal(fingerprint(root, SOURCE), fingerprintSubmodule(root, SOURCE));
  assert.throws(() => fingerprint(root, 'config'), /Only the pinned/);
});
test('tracked or untracked submodule changes invalidate review instead of being silently omitted', t => {
  const { root, source } = fixture(t); const before = fingerprintSubmodule(root, SOURCE);
  fs.writeFileSync(path.join(source, 'source.txt'), 'changed'); assert.throws(() => fingerprintSubmodule(root, SOURCE), /clean/);
  fs.writeFileSync(path.join(source, 'source.txt'), 'original'); assert.equal(fingerprintSubmodule(root, SOURCE), before);
  fs.writeFileSync(path.join(source, 'new.txt'), 'unreviewed'); assert.throws(() => fingerprintSubmodule(root, SOURCE), /clean/);
});
test('review refuses mismatched commit, alternate fork and changed module origin', t => {
  const { root, git, config } = fixture(t), file = path.join(root, 'config/openchatcut-runtime.json');
  fs.writeFileSync(file, JSON.stringify({ ...config, engineCommit: 'a'.repeat(40) })); assert.throws(() => fingerprintSubmodule(root, SOURCE), /pinned/);
  fs.writeFileSync(file, JSON.stringify({ ...config, repository: 'https://example.invalid/repo' })); assert.throws(() => fingerprintSubmodule(root, SOURCE), /Invalid pinned/);
  fs.writeFileSync(file, JSON.stringify(config)); git(['remote', 'set-url', 'origin', 'https://example.invalid/repo']); assert.throws(() => fingerprintSubmodule(root, SOURCE), /approved fork/);
});
test('isolated delivery initializes the fixed module then installs without scripts and builds its reviewed adapter', t => {
  const { root } = fixture(t), calls = [];
  prepareSource(root, (cwd, args) => calls.push({ cwd, args }), (cwd, executable, args) => calls.push({ cwd, executable, args }), 'npm-cli.js');
  assert.deepEqual(calls[0].args, ['submodule', 'update', '--init', '--checkout', '--', SOURCE]);
  assert.equal(calls[1].cwd, path.join(root, SOURCE));
  assert.deepEqual(calls[1].args, ['npm-cli.js', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(calls[2].args, [path.join(root, 'scripts/build-openchatcut.cjs')]);
});
test('package resources preserve updater, source binding and signing policy while including required runtime files', t => {
  const { root, source, config } = fixture(t), attempt = path.join(root, 'attempt'); fs.mkdirSync(attempt);
  const binary = path.join(root, 'node_modules/ffmpeg-static/ffmpeg.exe'); fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'audited-fixture');
  fs.mkdirSync(path.join(root, 'desktop')); fs.writeFileSync(path.join(root, 'desktop/ffmpeg-runtime.json'), JSON.stringify({ 'win32-x64': { sha256: 'approved' } }));
  fs.writeFileSync(path.join(root, 'electron-builder.yml'), 'files:\n  - desktop/**\nextraResources: []\n');
  const original = { appId: 'approved-id', publish: ['approved-feed'], forceCodeSigning: true, extraMetadata: { novaBuild: { commit: 'b'.repeat(40), clean: true } }, extraResources: [{ from: 'original', to: 'original' }] };
  const options = { runtime: { inspectOpenChatCutRuntime: () => ({ available: true, sourceRoot: source }), hashFile: () => 'approved', readConfiguration: () => config }, copyRuntime(from, to, c, options) { assert.equal(from, source); assert.equal(c, config); assert.equal(options.sharedFfmpeg.sha256, 'approved'); fs.mkdirSync(path.join(to, 'node_modules'), { recursive: true }); } };
  const result = preparePackage(root, attempt, original, options);
  for (const key of ['appId', 'publish', 'forceCodeSigning', 'extraMetadata']) assert.equal(result[key], original[key]);
  assert.ok(result.files.includes('scripts/openchatcut-runtime.cjs')); assert.ok(result.files.includes('config/openchatcut-runtime.json'));
  assert.ok(result.extraResources.some(item => item.to === 'openchatcut/node_modules'));
  assert.ok(result.extraResources.some(item => item.to === 'original'));
  assert.throws(() => preparePackage(root, attempt, original, { runtime: { inspectOpenChatCutRuntime: () => ({ available: false, code: 'EDITOR_BUILD_INVALID' }) } }), /EDITOR_BUILD_INVALID/);
});
