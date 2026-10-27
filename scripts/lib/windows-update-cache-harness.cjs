'use strict';
// Real NSIS compilation of cache-only macros. Never installs an application.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('app-builder-lib');
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');

function childDirectory(root, prefix) {
  const entry = fs.readdirSync(root, { withFileTypes: true }).find(e => e.isDirectory() && e.name.startsWith(prefix));
  if (!entry) throw new Error('Prepared NSIS tool unavailable; no tool download is permitted.');
  return path.join(root, entry.name);
}
function compileCacheHarness({ directory, appId, version, cacheDirectory, source, copyFailure = false, uninstaller = false }) {
  fs.mkdirSync(directory, { recursive: true });
  const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache');
  const binary = path.join(childDirectory(path.join(cache, 'nsis-3.0.4.1'), 'nsis-3.'), 'Bin/makensis.exe');
  const plugins = path.join(childDirectory(path.join(cache, 'nsis-resources-3.4.1'), 'nsis-resources-'), 'plugins/x86-unicode');
  const repository = path.resolve(__dirname, '../..');
  const executable = path.join(directory, 'cache-only.exe');
  const filename = path.join(directory, 'cache-only.nsi');
  const defines = { APP_FILENAME: 'nova-image' };
  // Exercise the pinned target's actual define computation: it starts wrong.
  NsisTarget.prototype.configureDefinesForAllTypeOfInstaller.call({ packager: { appInfo: { productFilename: 'Nova', updaterCacheDirName: 'nova-image-updater' } }, isWebInstaller: false, options: {} }, defines);
  const escaped = text => text.replace(/\$/g, '$$').replace(/"/g, '$\\"');
  const lines = [
    'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
    '!include "' + repository + '/node_modules/app-builder-lib/templates/nsis/include/StdUtils.nsh"',
    '!addplugindir "' + plugins + '"',
    '!define PROJECT_DIR "' + repository + '"', '!define APP_ID "' + appId + '"', '!define VERSION "' + version + '"',
    '!define APP_INSTALLER_STORE_FILE "' + defines.APP_INSTALLER_STORE_FILE + '"',
    ...(uninstaller ? ['!define BUILD_UNINSTALLER'] : []),
    // Fail if a helper include ever masks this first-include compilation regression.
    '!ifdef LOGICLIB', '!error "LogicLib loaded before the custom installer include"', '!endif',
    '!include "' + repository + '/desktop/installer/update-cache-installer.nsh"',
    // The pinned builder injects its custom include before installer.nsi headers.
    '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
    '!insertmacro customHeader',
    '!echo "NOVA_COMPILED_STORE=${APP_INSTALLER_STORE_FILE}"',
    ...(!uninstaller ? ['Var installMode'] : []),
    'OutFile "' + executable + '"', 'Section',
    ...(!uninstaller ? [
    // Expand supported hooks in a branch that is compiled but never executed.
    // Real customInit uses LOCALAPPDATA, so tests run only the parameterized core.
    'StrCpy $installMode "compile-only"', '${If} $installMode == "never-run"',
    '!insertmacro customInit', '!insertmacro customInstall', '${EndIf}',
    '!insertmacro novaPrepareInstallerCache "' + escaped(cacheDirectory) + '"',
    // Same original builder CopyFiles semantics, redirected by customHeader.
    'ClearErrors', 'CopyFiles /SILENT "' + escaped(source) + '" "' + escaped(path.dirname(cacheDirectory)) + '\\${APP_INSTALLER_STORE_FILE}"',
    ...(copyFailure ? ['SetFileAttributes "$novaCacheRoot\\installer.next.exe" READONLY'] : []),
    '!insertmacro novaPublishInstallerCache "' + escaped(source) + '"',
    ] : []),
    'SectionEnd',
  ];
  fs.writeFileSync(filename, lines.map(line => line.startsWith('!include') || line.startsWith('!addplugindir') ? line.replace(/\//g, '\\') : line).join('\n'));
  const compiled = spawnSync(binary, ['-V4', '-WX', '-INPUTCHARSET', 'UTF8', filename], { encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(directory, 'compile.log'), compiled.stdout + compiled.stderr);
  if (compiled.error || compiled.status !== 0) throw new Error('Cache-only NSIS compilation failed: ' + compiled.stdout + compiled.stderr);
  const expected = appId + '-updater\\installer.next.exe';
  if (!compiled.stdout.includes('NOVA_COMPILED_STORE=' + expected)) throw new Error('Final NSIS cache define differs.');
  return { executable, filename, expectedStore: expected, execute() {
    const result = spawnSync(executable, ['/S'], { windowsHide: true, timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error('Cache-only macro failed: ' + (result.error?.message || result.status));
  } };
}
module.exports = { compileCacheHarness };
