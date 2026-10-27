'use strict';
// Builder 26.15.3 runs system afterPack handlers before this user handler.
// Builder otherwise derives cache identity from package.name, shared by test/release.
module.exports = async context => {
  const fs = require('node:fs');
  const path = require('node:path');
  const yaml = require('js-yaml');
  const policy = context.packager.info.metadata.novaUpdate;
  if (!policy || policy.schemaVersion !== 1 || policy.appId !== context.packager.appInfo.id) throw new Error('Update identity missing in packaged metadata.');
  const file = path.join(context.appOutDir, 'resources', 'app-update.yml');
  const config = yaml.load(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(policy.feed)) if (config[key] !== value) throw new Error('Builder feed differs from fixed policy.');
  if (policy.updaterCacheDirName !== policy.appId + '-updater') throw new Error('NSIS/runtime cache identity differs.');
  config.updaterCacheDirName = policy.updaterCacheDirName;
  fs.writeFileSync(file, yaml.dump(config));
  if (policy.profile === 'github-test') {
    if (!require('../desktop/update-identity.cjs').isGithubTestMetadata(policy)) throw new Error('Invalid GitHub test package identity.');
    // Inherited extraResources are concatenated by builder. Remove only these
    // two obsolete copied notices inside this attempt, never application data.
    const resources = path.resolve(context.appOutDir, 'resources');
    if (fs.lstatSync(resources).isSymbolicLink()) throw new Error('Unsafe packaged resources directory.');
    for (const name of ['LOCAL-TEST-NOTICE.txt', '本地离线测试版使用说明.md']) {
      const target = path.join(resources, name);
      if (path.dirname(target) !== resources) throw new Error('Unsafe copied notice path.');
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Copied obsolete notice is not an ordinary file.');
        fs.unlinkSync(target);
      }
    }
  }
};
