'use strict';
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const GITHUB_TEST_IDENTITY = Object.freeze({ appId: 'com.novaimage.studio.github-test', productName: 'Nova Studio GitHub Test' });
const GITHUB_TEST_FEED = Object.freeze({ provider: 'github', owner: 'hanjiyou', repo: 'nova-video-studio', private: false, channel: 'nova-test', releaseType: 'release' });
function isGithubTestMetadata(metadata, version = metadata?.version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const parts = version.split('.').map(Number);
  if (parts.some(n => n > 65535) || parts[0] < 3 || (parts[0] === 3 && parts[1] < 6)) return false;
  return isDeepStrictEqual(metadata, { schemaVersion: 1, profile: 'github-test', version, windowsVersion: version + '.0', minimumUpdatableVersion: '3.6.0', ...GITHUB_TEST_IDENTITY, updaterCacheDirName: GITHUB_TEST_IDENTITY.appId + '-updater', feed: GITHUB_TEST_FEED, signature: { mode: 'unsigned-github-test', publisherNames: [] }, runtimeReady: true });
}
// Called before reading userData, creating a directory or taking the instance lock.
// Legacy profiles keep Electron's existing path. A malformed new test package fails
// closed instead of falling through to the old nova-image data directory.
function resolvePackageSystemUserData({ app, pkg }) {
  if (pkg?.novaUpdate?.profile !== 'github-test') return app.getPath('userData');
  if (!app.isPackaged || pkg.name !== 'nova-image' || pkg.productName !== GITHUB_TEST_IDENTITY.productName || pkg.version !== app.getVersion() || !isGithubTestMetadata(pkg.novaUpdate, pkg.version)) throw new Error('GitHub test package identity is invalid.');
  app.setName(GITHUB_TEST_IDENTITY.productName);
  return path.join(app.getPath('appData'), GITHUB_TEST_IDENTITY.productName);
}
module.exports = { GITHUB_TEST_IDENTITY, GITHUB_TEST_FEED, isGithubTestMetadata, resolvePackageSystemUserData };
