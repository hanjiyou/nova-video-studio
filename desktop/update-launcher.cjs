'use strict';
const { spawn } = require('node:child_process');
// Pinned 6.8.11 doInstall schedules app.quit before its async spawn settles.
// Retain quitAndInstall, but require the actual child "spawn" event before allowing quit.
function attachInstallerLaunchProof(updater, spawnImpl = spawn) {
  if (require('electron-updater/package.json').version !== '6.8.11') throw Error('Installer lifecycle requires reviewed electron-updater 6.8.11');
  let proof;
  updater.spawnLog = (file, args = [], env = undefined, stdio = 'ignore') => {
    proof = new Promise((resolve, reject) => {
      try {
        const child = spawnImpl(file, args, { stdio, env, detached: true, windowsHide: true });
        child.once('spawn', () => { child.unref(); resolve(true); });
        // Use a fixed code so NsisUpdater cannot fall back to shell.openPath without spawn proof.
        child.once('error', () => reject(Object.assign(new Error('Installer launch failed'), { code: 'NOVA_INSTALLER_START_FAILED' })));
      } catch { reject(Object.assign(new Error('Installer launch failed'), { code: 'NOVA_INSTALLER_START_FAILED' })); }
    });
    proof.catch(() => {});
    return proof;
  };
  return { async confirm() { if (!proof) return false; let timer; try { return await Promise.race([proof, new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]); } catch { return false; } finally { clearTimeout(timer); } } };
}
module.exports = { attachInstallerLaunchProof };
