'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { createRequire } = require('node:module');
const { parseDn } = require('builder-util-runtime');
const { parseUpdateInfo, resolveFiles } = require('electron-updater/out/providers/Provider');
const builderRequire = createRequire(require.resolve('app-builder-lib'));
const yaml = builderRequire('js-yaml');
const { blake2b } = builderRequire('@noble/hashes/blake2.js');

const { GITHUB_TEST_IDENTITY, GITHUB_TEST_FEED } = require('../../desktop/update-identity.cjs');

const REPOSITORY = path.resolve(__dirname, '../..');
const POLICY_PATH = path.join(REPOSITORY, 'config/windows-update.json');

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function stableVersion(value) {
  invariant(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), 'Use stable three-part SemVer without a tag, prerelease, build metadata, or fourth part.');
  invariant(value.split('.').every(part => Number(part) <= 65535), 'Windows version components must be at most 65535.');
  return value;
}

function compareVersions(a, b) {
  const x = stableVersion(a).split('.').map(Number), y = stableVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}

function localFeed(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('local-test requires an explicit loopback --test-feed-url.'); }
  invariant(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/'), 'Test feed must be http://127.0.0.1:<port>/<path>/ or http://[::1]:<port>/<path>/, without credentials, query or fragment.');
  return { provider: 'generic', url: url.href, channel: 'latest', useMultipleRangeRequest: false };
}

function readPolicy() {
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  invariant(policy.schemaVersion === 1, 'Unsupported update policy schema.');
  invariant(policy.updaterVersion === require('electron-updater/package.json').version, 'Installed updater differs from policy.');
  invariant(policy.builderVersion === require('electron-builder/package.json').version, 'Installed builder differs from policy.');
  invariant(policy.electronVersion === require('electron/package.json').version, 'Installed Electron differs from policy.');
  return policy;
}

function makePlan(options = {}, policy = readPolicy(), repository = REPOSITORY) {
  const profile = options.profile || 'local-test';
  invariant(['local-test', 'github-test', 'release'].includes(profile), 'Profile must be local-test, github-test or release.');
  const version = stableVersion(options.version || policy.bootstrapVersion);
  const minimumUpdatableVersion = profile === 'github-test' ? '3.6.0' : policy.minimumUpdatableVersion;
  invariant(compareVersions(version, minimumUpdatableVersion) >= 0, 'Version is below the minimum updatable version.');
  const identity = policy.identities[profile];
  invariant(identity && identity.appId && identity.productName, 'Installation identity is missing.');
  const fixedIdentity = profile === 'github-test' ? GITHUB_TEST_IDENTITY : profile === 'local-test' ? { appId: 'com.novaimage.studio.offline-test.followup-20261024', productName: 'Nova Studio T16 Followup' } : { appId: 'com.novaimage.studio', productName: 'Nova Image Studio' };
  invariant(isDeepStrictEqual(identity, fixedIdentity) && policy.minimumUpdatableVersion === '3.5.0', 'Fixed installation identity/minimum version has changed.');
  invariant(options.enableTestRuntime === undefined || typeof options.enableTestRuntime === 'boolean', 'Test runtime flag must be boolean.');
  invariant(!options.enableTestRuntime || (profile === 'local-test' && compareVersions(version, '3.5.2') >= 0), 'Test runtime requires local-test version 3.5.2 or higher.');
  let feed, signature;
  if (profile === 'local-test') {
    feed = localFeed(options.testFeedUrl);
    signature = { mode: 'unsigned-local-test', publisherNames: [] };
  } else if (profile === 'github-test') {
    invariant(!options.testFeedUrl, 'GitHub test builds cannot override the fixed feed.');
    invariant(isDeepStrictEqual(policy.githubTestFeed, GITHUB_TEST_FEED), 'GitHub test feed must remain the fixed approved repository/channel.');
    feed = { ...GITHUB_TEST_FEED };
    signature = { mode: 'unsigned-github-test', publisherNames: [] };
  } else {
    invariant(!options.testFeedUrl, 'Release builds cannot use a test feed.');
    const source = policy.githubFeed;
    invariant(isDeepStrictEqual(source, { provider: 'github', owner: 'hanjiyou', repo: 'nova-video-studio', private: false, channel: 'latest', releaseType: 'release' }), 'Release feed must remain the fixed approved GitHub feed repository.');
    invariant(source && source.provider === 'github' && /^[A-Za-z0-9-]+$/.test(source.owner) && /^[A-Za-z0-9_.-]+$/.test(source.repo) && source.private === false && source.channel === 'latest', 'An approved public GitHub feed must be configured for release builds.');
    invariant(policy.signing.status === 'approved' && Array.isArray(policy.signing.publisherNames) && policy.signing.publisherNames.length > 0 && policy.signing.publisherNames.every(n => typeof n === 'string' && n.trim()), 'Release signing/publisher decision is pending. Only explicit unsigned test profiles are currently allowed.');
    feed = { provider: 'github', owner: source.owner, repo: source.repo, private: false, channel: 'latest', releaseType: 'release' };
    signature = { mode: 'authenticode', publisherNames: policy.signing.publisherNames };
  }
  const metadata = { schemaVersion: 1, profile, version, windowsVersion: `${version}.0`, minimumUpdatableVersion, ...identity, updaterCacheDirName: `${identity.appId}-updater`, feed, signature, runtimeReady: profile === 'github-test' || (profile === 'local-test' ? options.enableTestRuntime === true : policy.runtimeReady === true) };
  const artifactName = `Nova-Studio-${version}-${profile === 'local-test' ? 'update-test' : profile === 'github-test' ? 'github-test' : 'win'}-x64.exe`;
  const root = path.join(repository, 'release-updates');
  return { ...metadata, metadata, artifactName, manifestName: profile === 'github-test' ? 'nova-test.yml' : 'latest.yml', tag: `v${version}`, root, output: path.join(root, profile, version) };
}

// Only runtimeReady is historical. Every identity, feed, publisher and tool rule
// still comes from the current fixed policy; the saved record cannot define them.
function planForRecord(record, policy = readPolicy(), repository = REPOSITORY) {
  invariant(record && typeof record.metadata?.runtimeReady === 'boolean', 'Saved runtimeReady must be boolean.');
  invariant(record.profile !== 'github-test' || record.metadata.runtimeReady === true, 'GitHub test runtime must remain explicitly enabled.');
  const plan = makePlan({ profile: record.profile, version: record.version, testFeedUrl: record.testFeedUrl, enableTestRuntime: record.profile === 'local-test' && record.metadata.runtimeReady }, policy, repository);
  plan.runtimeReady = record.metadata.runtimeReady;
  plan.metadata = { ...plan.metadata, runtimeReady: record.metadata.runtimeReady };
  invariant(isDeepStrictEqual(record.metadata, plan.metadata), 'Saved build plan differs from fixed identity/feed/signature policy.');
  if (plan.profile === 'release' || record.source !== undefined) {
    invariant(record.source?.clean === true && /^[a-f0-9]{40}$/.test(record.source.commit) && Object.keys(record.source).sort().join('|') === 'clean|commit', 'Release build must record a clean source commit.');
    plan.source = record.source;
  }
  return plan;
}

async function verifyDirectory(directory, options = {}) {
  directory = path.resolve(directory);
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'update-plan.json'), 'utf8'));
  const plan = planForRecord(record);
  const summary = await verifyArtifacts(directory, plan, options);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'update-summary.json'), 'utf8'));
  invariant(isDeepStrictEqual(saved, summary), 'Saved summary differs from verified bytes/policy.');
  return { plan, summary };
}

function assertInstallerNoticeEncoding(filename) {
  assertOrdinaryFile(filename);
  const bytes = fs.readFileSync(filename);
  invariant(bytes.length > 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'NSIS installer notice must be UTF-8 with BOM: ' + path.basename(filename));
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('NSIS installer notice contains invalid UTF-8: ' + path.basename(filename)); }
}

function builderConfiguration(plan, attempt, repository = REPOSITORY) {
  const baseConfig = yaml.load(fs.readFileSync(path.join(repository, 'electron-builder.yml'), 'utf8'));
  // Explicit nsis.license bypasses electron-builder's localized-file BOM conversion.
  const notice = plan.profile === 'github-test' ? 'desktop/installer/GITHUB-TEST-NOTICE.txt' : baseConfig.nsis?.license;
  invariant(typeof notice === 'string' && notice.length > 0, 'NSIS installer notice is required.');
  assertInstallerNoticeEncoding(path.resolve(repository, notice));
  return {
    extends: path.join(repository, 'electron-builder.update.yml'),
    appId: plan.appId,
    productName: plan.productName,
    buildVersion: plan.windowsVersion,
    extraMetadata: { version: plan.version, ...(plan.profile === 'github-test' ? { productName: plan.productName } : {}), novaUpdate: plan.metadata, ...(plan.source ? { novaBuild: plan.source } : {}) },
    afterPack: path.join(repository, 'scripts/finalize-windows-update.cjs'),
    directories: { output: attempt },
    publish: [plan.feed],
    ...(plan.profile === 'github-test' ? { extraResources: baseConfig.extraResources.filter(entry => !['docs/本地离线测试版使用说明.md', 'desktop/installer/LOCAL-TEST-NOTICE.txt'].includes(entry.from)).concat([{ from: 'docs/Windows-GitHub测试版使用说明.md', to: 'GitHub测试版使用说明.md' }, { from: 'desktop/installer/GITHUB-TEST-NOTICE.txt', to: 'GITHUB-TEST-NOTICE.txt' }]) } : {}),
    forceCodeSigning: plan.signature.mode === 'authenticode',
    win: {
      artifactName: plan.artifactName,
      signAndEditExecutable: true,
      signExecutable: plan.signature.mode === 'authenticode',
      verifyUpdateCodeSignature: plan.signature.mode === 'authenticode',
      ...(plan.signature.mode === 'authenticode' ? { publisherName: plan.signature.publisherNames } : {}),
    },
    nsis: { uninstallDisplayName: `${plan.productName} ${plan.version}`, ...(plan.profile === 'github-test' ? { createDesktopShortcut: true, createStartMenuShortcut: true, license: path.join(repository, 'desktop/installer/GITHUB-TEST-NOTICE.txt') } : {}) },
  };
}

function assertNewOutput(plan) {
  invariant(!fs.existsSync(plan.output), `Version output already exists and will not be overwritten: ${plan.output}`);
}

function assertOrdinaryFile(filename) {
  const stat = fs.lstatSync(filename);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `Required non-empty ordinary file missing: ${path.basename(filename)}`);
  return stat;
}

async function hashFile(filename, encoding = 'base64') {
  const hash = createHash('sha512');
  for await (const data of fs.createReadStream(filename)) hash.update(data);
  return hash.digest(encoding);
}

function verifyBlockmap(filename, installer, expectedSize) {
  invariant(assertOrdinaryFile(filename).size <= 16 * 1024 * 1024, 'Blockmap exceeds the supported size.');
  const map = JSON.parse(gunzipSync(fs.readFileSync(filename), { maxOutputLength: 64 * 1024 * 1024 }));
  invariant(map.version === '2' && Array.isArray(map.files) && map.files.length === 1, 'Unsupported blockmap format.');
  const file = map.files[0];
  invariant(file.name === 'file' && file.offset === 0 && Array.isArray(file.sizes) && Array.isArray(file.checksums) && file.sizes.length > 0 && file.sizes.length === file.checksums.length, 'Invalid blockmap file layout.');
  const fd = fs.openSync(installer, 'r');
  let position = 0;
  try {
    for (let i = 0; i < file.sizes.length; i++) {
      const size = file.sizes[i];
      invariant(Number.isSafeInteger(size) && size > 0 && size <= 32768 && position + size <= expectedSize, 'Invalid blockmap chunk size.');
      const chunk = Buffer.alloc(size);
      invariant(fs.readSync(fd, chunk, 0, size, position) === size, 'Blockmap extends beyond installer.');
      invariant(Buffer.from(blake2b(chunk, { dkLen: 18 })).toString('base64') === file.checksums[i], 'Blockmap checksum does not match installer bytes.');
      position += size;
    }
  } finally { fs.closeSync(fd); }
  invariant(position === expectedSize, 'Blockmap does not cover the complete installer.');
  return { chunks: file.sizes.length, size: position };
}

// Mirrors electron-updater 6.8.11: a configured DN matches each field; plain names match CN.
function publisherMatches(subject, name) {
  const actual = parseDn(subject), expected = parseDn(name);
  return expected.size ? Array.from(expected.keys()).every(key => expected.get(key) === actual.get(key)) : name === actual.get('CN');
}

function inspectWindowsFiles(filenames) {
  invariant(process.platform === 'win32', 'Authenticode/PE inspection requires Windows.');
  const literals = filenames.map(name => `'${name.replace(/'/g, "''")}'`).join(',');
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; @(${literals}) | ForEach-Object { $s=Get-AuthenticodeSignature -LiteralPath $_; $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($_); [pscustomobject]@{file=$_;status=$s.Status.ToString();subject=$(if($s.SignerCertificate){$s.SignerCertificate.Subject}else{''});fileVersion=$v.FileVersion;productVersion=$v.ProductVersion} } | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PSModulePath: '' } });
  invariant(!result.error && result.status === 0, 'Windows signature/version inspection failed.');
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function verifyArtifacts(directory, plan, options = {}) {
  directory = path.resolve(directory);
  const installer = path.join(directory, plan.artifactName);
  const size = assertOrdinaryFile(installer).size;
  const fd = fs.openSync(installer, 'r');
  try { const header = Buffer.alloc(2); fs.readSync(fd, header, 0, 2, 0); invariant(header.toString() === 'MZ', 'Installer is not a Windows executable.'); } finally { fs.closeSync(fd); }
  const manifestName = plan.manifestName;
  invariant(plan.profile !== 'github-test' || !fs.existsSync(path.join(directory, 'latest.yml')), 'GitHub test must not generate the formal latest.yml manifest.');
  const raw = fs.readFileSync(path.join(directory, manifestName), 'utf8');
  const info = parseUpdateInfo(raw, manifestName, 'local-verification');
  invariant(info && info.version === plan.version && Array.isArray(info.files) && info.files.length === 1 && !info.packages, 'Manifest version/files do not match this full NSIS build.');
  const entry = info.files[0];
  invariant(entry.url === plan.artifactName && info.path === plan.artifactName, 'Manifest path does not match the expected installer basename.');
  invariant(entry.size === size, 'Manifest installer size does not match.');
  const sha512 = await hashFile(installer);
  invariant(entry.sha512 === sha512 && info.sha512 === sha512, 'Manifest SHA512 does not match installer bytes.');
  const resolved = resolveFiles(info, new URL('http://127.0.0.1/'));
  invariant(resolved.length === 1 && decodeURIComponent(resolved[0].url.pathname) === `/${plan.artifactName}`, 'Pinned updater cannot resolve the installer.');
  const blockmap = verifyBlockmap(installer + '.blockmap', installer, size);
  const resources = path.join(directory, 'win-unpacked/resources');
  if (plan.profile === 'github-test') {
    for (const name of ['LOCAL-TEST-NOTICE.txt', '本地离线测试版使用说明.md']) invariant(!fs.existsSync(path.join(resources, name)), 'GitHub test still includes obsolete offline-only copied notices.');
    for (const name of ['GITHUB-TEST-NOTICE.txt', 'GitHub测试版使用说明.md']) assertOrdinaryFile(path.join(resources, name));
  }
  const asar = path.join(resources, 'app.asar');
  assertOrdinaryFile(asar);
  const packaged = JSON.parse(builderRequire('@electron/asar').extractFile(asar, 'package.json').toString('utf8'));
  invariant(packaged.name === 'nova-image' && packaged.version === plan.version && isDeepStrictEqual(packaged.novaUpdate, plan.metadata), 'Packaged version/update identity differs from the build plan.');
  if (plan.profile === 'github-test') invariant(packaged.productName === plan.productName, 'GitHub test package.productName must match its isolated system data identity.');
  if (plan.profile === 'release' || plan.source) invariant(plan.source?.clean === true && isDeepStrictEqual(packaged.novaBuild, plan.source), 'Packaged clean source commit differs from release build record.');
  invariant(packaged.dependencies && packaged.dependencies['electron-updater'] === readPolicy().updaterVersion, 'Packaged updater dependency is not pinned.');
  const updateConfig = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
  const permitted = new Set([...Object.keys(plan.feed), 'updaterCacheDirName', ...(plan.signature.mode === 'authenticode' ? ['publisherName'] : [])]);
  invariant(Object.keys(updateConfig).every(key => permitted.has(key)), 'Packaged update config contains unexpected fields (including possible credentials).');
  for (const [key, value] of Object.entries(plan.feed)) invariant(updateConfig[key] === value, 'Packaged feed differs from fixed build feed.');
  invariant(updateConfig.updaterCacheDirName === plan.updaterCacheDirName, 'Updater cache identity is missing.');
  if (plan.signature.mode === 'authenticode') invariant(JSON.stringify(updateConfig.publisherName) === JSON.stringify(plan.signature.publisherNames), 'Packaged publisher validation is missing or changed.');
  const appExe = path.join(directory, 'win-unpacked', `${plan.productName}.exe`);
  assertOrdinaryFile(appExe);
  const inspections = (options.inspectWindowsFiles || inspectWindowsFiles)([installer, appExe]);
  invariant(inspections.length === 2 && inspections[0].fileVersion === plan.windowsVersion && inspections[0].productVersion === plan.version && inspections[1].fileVersion === plan.windowsVersion && inspections[1].productVersion === plan.windowsVersion, 'Windows application version resources do not match SemVer/buildVersion.');
  for (const item of inspections) {
    if (['unsigned-local-test', 'unsigned-github-test'].includes(plan.signature.mode)) invariant(item.status === 'NotSigned', 'Test build must be explicitly unsigned; unexpected signature status.');
    else invariant(item.status === 'Valid' && plan.signature.publisherNames.some(name => publisherMatches(item.subject, name)), 'Release signature is invalid or publisher differs from the approved identity.');
  }
  return { schemaVersion: 1, profile: plan.profile, version: plan.version, windowsVersion: plan.windowsVersion, appId: plan.appId, productName: plan.productName, tag: plan.tag, installer: plan.artifactName, size, sha512, blockmap: { name: plan.artifactName + '.blockmap', sha512: await hashFile(installer + '.blockmap'), ...blockmap }, manifest: { name: manifestName, sha512: await hashFile(path.join(directory, manifestName)) }, feed: plan.feed, signature: { mode: plan.signature.mode, results: inspections.map(({ status, subject, fileVersion, productVersion }) => ({ status, subject, fileVersion, productVersion })) }, runtimeReady: plan.runtimeReady, ...(plan.source ? { source: plan.source } : {}), publication: 'not-published' };
}

module.exports = { REPOSITORY, readPolicy, stableVersion, compareVersions, localFeed, makePlan, planForRecord, verifyDirectory, hashFile, assertInstallerNoticeEncoding, builderConfiguration, assertNewOutput, verifyArtifacts, verifyBlockmap, inspectWindowsFiles, publisherMatches };
