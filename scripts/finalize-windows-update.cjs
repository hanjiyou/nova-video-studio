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
  config.updaterCacheDirName = policy.updaterCacheDirName;
  fs.writeFileSync(file, yaml.dump(config));
};
