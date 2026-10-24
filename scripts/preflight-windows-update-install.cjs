'use strict';
// Read-only, exact test installation identity. Never enumerate/read user data.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { UUID } = require('builder-util-runtime');
const { isInstalledNsis, validateMetadata, readNsisInstallLocation } = require('../desktop/update-policy.cjs');
const { verifyDirectory } = require('./lib/windows-update.cjs');
async function preflight(directory) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 required.');
  const { plan, summary } = await verifyDirectory(directory);
  if (plan.profile !== 'local-test' || !plan.runtimeReady) throw new Error('Use an enabled local-test package, version 3.5.2 or higher.');
  const guid = UUID.v5(plan.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  const registry = [];
  for (const root of ['HKCU', 'HKLM']) {
    try {
      const location = readNsisInstallLocation(root, guid);
      if (location) {
        const installDirectory = path.resolve(location), exe = path.join(installDirectory, plan.productName + '.exe');
        const app = { isPackaged: true, getAppPath: () => path.join(installDirectory, 'resources/app.asar'), getPath: () => exe };
        registry.push({ hive: root, installDirectory, executablePresent: fs.existsSync(exe), exactInstalledNsis: isInstalledNsis(app, plan.metadata) });
      } else registry.push({ hive: root, registrationPresent: false });
    } catch { registry.push({ hive: root, registrationPresent: false }); }
  }
  const command = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Get-CimInstance Win32_Process -Filter "Name='${plan.productName}.exe'" | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`;
  const proc = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, PSModulePath: '' } }).trim();
  const modes = {};
  for (const dataMode of ['system', 'override', 'portable']) modes[dataMode] = validateMetadata({ metadata: plan.metadata, config: { ...plan.feed, updaterCacheDirName: plan.updaterCacheDirName }, version: plan.version, platform: 'win32', arch: 'x64', packaged: true, installed: true, dataMode });
  return { schemaVersion: 1, packageVersion: plan.version, packageSha512: summary.sha512, appId: plan.appId, exactRegistryKey: `Software\\${guid}`, registry, runningTestProcesses: proc ? JSON.parse(proc) : [], dataModeContract: Object.fromEntries(Object.entries(modes).map(([mode, p]) => [mode, { supported: p.supported, installSupported: p.installSupported === true, reason: p.installReason || p.reason || null }])), isolatedWindowsAccountAndSystemData: 'not-established', installationAllowedByThisPreflight: false, status: 'REAL_END_TO_END_INSTALL_PENDING', reason: 'A separately authorized isolated Windows account/system data environment has not been established. No installer is launched and no existing AppData directory is inspected or modified.' };
}
if (require.main === module) Promise.resolve().then(() => { if (process.argv.length !== 3) throw new Error('Usage: node scripts/preflight-windows-update-install.cjs <enabled-test-build>'); return preflight(process.argv[2]); }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error('[FAILED] ' + error.message); process.exitCode = 1; });
module.exports = { preflight };
