'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { UUID } = require('builder-util-runtime');
const { load } = require('js-yaml');
const { GITHUB_TEST_IDENTITY, GITHUB_TEST_FEED, isGithubTestMetadata } = require('./update-identity.cjs');
const IDENTITIES = Object.freeze({ 'github-test': GITHUB_TEST_IDENTITY, 'local-test': { appId: 'com.novaimage.studio.offline-test.followup-20261024', productName: 'Nova Studio T16 Followup' }, release: { appId: 'com.novaimage.studio', productName: 'Nova Image Studio' } });
const GITHUB = Object.freeze({ provider: 'github', owner: 'hanjiyou', repo: 'nova-video-studio', private: false, channel: 'latest', releaseType: 'release' });
function stable(value) { return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.split('.').every(n => Number(n) <= 65535); }
function compare(a, b) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]); return 0; }
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|'); }
function loopbackFeed(feed) {
  if (!exact(feed, ['provider', 'url', 'channel', 'useMultipleRangeRequest']) || feed.provider !== 'generic' || feed.channel !== 'latest' || feed.useMultipleRangeRequest !== false) return false;
  try { const u = new URL(feed.url); return u.href === feed.url && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname) && !!u.port && !u.username && !u.password && !u.search && !u.hash && u.pathname.endsWith('/'); } catch { return false; }
}
function validateMetadata({ metadata: m, config, version, platform, arch, packaged, installed, dataMode }) {
  if (platform !== 'win32' || arch !== 'x64' || !packaged || !installed || dataMode === 'portable') return { supported: false, reason: 'INSTALLATION_UNSUPPORTED' };
  if (!m || m.runtimeReady !== true) return { supported: false, reason: 'UPDATE_NOT_ENABLED' };
  const bad = { supported: false, reason: 'UPDATE_METADATA_INVALID' };
  if (!exact(m, ['schemaVersion', 'profile', 'version', 'windowsVersion', 'minimumUpdatableVersion', 'appId', 'productName', 'updaterCacheDirName', 'feed', 'signature', 'runtimeReady']) || m.schemaVersion !== 1 || !IDENTITIES[m.profile] || !stable(m.version) || m.version !== version || m.windowsVersion !== version + '.0' || m.minimumUpdatableVersion !== (m.profile === 'github-test' ? '3.6.0' : '3.5.0') || compare(version, m.minimumUpdatableVersion) < 0) return bad;
  const identity = IDENTITIES[m.profile];
  if (m.appId !== identity.appId || m.productName !== identity.productName || m.updaterCacheDirName !== m.appId + '-updater' || !exact(m.signature, ['mode', 'publisherNames']) || !Array.isArray(m.signature.publisherNames)) return bad;
  if (m.profile === 'local-test') {
    if (!loopbackFeed(m.feed) || m.signature.mode !== 'unsigned-local-test' || m.signature.publisherNames.length) return bad;
  } else if (m.profile === 'github-test') {
    if (!isGithubTestMetadata(m, version) || !isDeepStrictEqual(m.feed, GITHUB_TEST_FEED)) return bad;
  } else {
    if (!isDeepStrictEqual(m.feed, GITHUB) || m.signature.mode !== 'authenticode' || !m.signature.publisherNames.length || !m.signature.publisherNames.every(n => typeof n === 'string' && n.trim() && n.length <= 1024)) return bad;
  }
  const expected = { ...m.feed, updaterCacheDirName: m.updaterCacheDirName, ...(m.profile === 'release' ? { publisherName: m.signature.publisherNames } : {}) };
  if (!isDeepStrictEqual(config, expected)) return bad;
  return { supported: true, installSupported: dataMode === 'system', installReason: dataMode === 'system' ? null : 'DATA_DIRECTORY_RESTART_UNPROVEN', metadata: m };
}
// Match builder 26.15.3's fixed NSIS install key, never scan other profiles/data.
function readNsisInstallLocation(hive, guid, run = execFileSync) {
  if (!['HKCU', 'HKLM'].includes(hive) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(guid)) throw new Error('Invalid exact NSIS registry key.');
  // reg.exe uses the active Windows code page. Explicit UTF-8 JSON preserves
  // Chinese installation directories and spaces without guessing the locale.
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::${hive === 'HKCU' ? 'CurrentUser' : 'LocalMachine'},[Microsoft.Win32.RegistryView]::Registry64); $key=$null; try { $key=$base.OpenSubKey('Software\\${guid}'); $value=if($key){$key.GetValue('InstallLocation',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null}; [Console]::Write((ConvertTo-Json -Compress -InputObject $value)) } finally { if($key){$key.Dispose()}; $base.Dispose() }`;
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PSModulePath: '' } });
  const location = JSON.parse(output.replace(/^\uFEFF/, ''));
  return typeof location === 'string' && location.trim() ? location : null;
}
function isInstalledNsis(app, metadata, { readRegistry = execFileSync, exists = fs.existsSync } = {}) {
  if (!metadata || !IDENTITIES[metadata.profile] || !app.isPackaged || !app.getAppPath().endsWith('app.asar')) return false;
  const identity = IDENTITIES[metadata.profile];
  if (metadata.appId !== identity.appId) return false;
  const guid = UUID.v5(identity.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  const directory = path.dirname(app.getPath('exe'));
  if (!exists(path.join(directory, `Uninstall ${identity.productName}.exe`))) return false;
  for (const root of ['HKCU', 'HKLM']) {
    try {
      const location = readNsisInstallLocation(root, guid, readRegistry);
      if (location && path.resolve(location).toLowerCase() === path.resolve(directory).toLowerCase()) return true;
    } catch { /* No matching installer registration is unsupported, not a network error. */ }
  }
  return false;
}
function readRuntimePolicy({ app, resourcesPath = process.resourcesPath, platform = process.platform, arch = process.arch, dataMode, installedProbe = isInstalledNsis }) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    if (!pkg.novaUpdate || pkg.novaUpdate.runtimeReady !== true) return { supported: false, reason: 'UPDATE_NOT_ENABLED' };
    if ((pkg.novaUpdate.profile === 'github-test' && pkg.productName !== GITHUB_TEST_IDENTITY.productName) || pkg.name !== 'nova-image' || pkg.dependencies?.['electron-updater'] !== '6.8.11' || require('electron-updater/package.json').version !== '6.8.11') return { supported: false, reason: 'UPDATE_METADATA_INVALID' };
    const config = load(fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8'), { schema: require('js-yaml').JSON_SCHEMA });
    return validateMetadata({ metadata: pkg.novaUpdate, config, version: app.getVersion(), platform, arch, packaged: app.isPackaged, installed: platform === 'win32' && installedProbe(app, pkg.novaUpdate), dataMode });
  } catch { return { supported: false, reason: 'UPDATE_METADATA_INVALID' }; }
}
module.exports = { validateMetadata, readRuntimePolicy, stable, compare, isInstalledNsis, readNsisInstallLocation };
