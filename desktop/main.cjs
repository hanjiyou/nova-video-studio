'use strict';
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, session, safeStorage, net: electronNet } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { resolveDataPolicy, resolveBackendPort } = require('./runtime.cjs');
const { resolvePackageSystemUserData } = require('./update-identity.cjs');
const packageMetadata = require('../package.json');
const { installNetworkPolicy } = require('./network.cjs');
const { createSessionPolicy, constrainNavigation } = require('./session-policy.cjs');
const { registerDesktopIpc } = require('./ipc.cjs');
const { createCredentialVault } = require('./credential-vault.cjs');
const { configureConnectionHost } = require('../backend/connections/host');
const { SESSION_HEADER, configureDesktopSession, revokeDesktopSession } = require('../backend/desktop-session');

const { reportStartupFailure } = require('./startup.cjs');
const { readRuntimePolicy } = require('./update-policy.cjs');
const { createUpdateService } = require('./update-service.cjs');
const { attachInstallerLaunchProof } = require('./update-launcher.cjs');
const { createUpdateQuitHandler } = require('./update-quit.cjs');
let dataPolicy, primary = false, initializationFailure;
try {
  dataPolicy = resolveDataPolicy({ systemUserData: resolvePackageSystemUserData({ app, pkg: packageMetadata }) });
  fs.mkdirSync(dataPolicy.directory, { recursive: true });
  app.setPath('userData', dataPolicy.directory);
  // The lock is scoped to this data profile, before SQLite/queue initialization.
  primary = app.requestSingleInstanceLock();
} catch (error) { initializationFailure = error; }
let mainWindow = null;
let backend;
let network;
let ipc;
let detachSession;
let stopping = false;
let allowQuit = false;
let exitCode = 0;
let updates, installerLaunch, updateFailureVisible = false;

async function reportUpdateFailure() {
  if (updateFailureVisible) return;
  updateFailureVisible = true;
  const options = { type: 'error', title: '更新尚未安装', message: '应用数据已关闭，更新尚未完成。', detail: '已下载更新和原有资料仍保留。请重新打开应用后重试，或关闭应用后手动更新。此时不能继续创作。', buttons: ['重新打开应用', '关闭应用'], defaultId: 0, cancelId: 1 };
  const result = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
  if (result.response === 0) app.relaunch();
  allowQuit = true; app.exit(0);
}

function prepareBackendEnv(port) {
  process.env.PORT = String(port);
  process.env.HOSTNAME = '127.0.0.1';
  process.env.NODE_ENV = 'production';
  process.env.NOVA_TASK_DB = path.join(dataPolicy.directory, 'nova-tasks.sqlite');
  process.env.NOVA_IMAGE_DIR = path.join(dataPolicy.directory, 'nova-images');
  process.env.NOVA_CDP_DIR = path.join(dataPolicy.directory, 'cdp-products');
  process.env.NOVA_PLUGIN_MEDIA_DIR = path.join(dataPolicy.directory, 'plugin-media');
  process.env.NOVA_STORAGE_DIR = path.join(dataPolicy.directory, 'storage');
  // The first-release desktop product exposes four workspaces only.
  process.env.NOVA_CDP_ENABLED = 'false';
  process.env.NOVA_CDP_LAUNCH_ENABLED = 'false';
  process.env.NOVA_AGENT_ENABLED = 'false';
}
async function cleanup() {
  revokeDesktopSession();
  network?.abortPending();
  await backend?.shutdown({ drain: false, timeoutMs: 2000 });
  ipc?.dispose();
  detachSession?.();
  network?.dispose();
}
function createWindow(origin, features) {
  mainWindow = new BrowserWindow({ width: 1440, height: 900, title: packageMetadata.novaUpdate?.profile === 'github-test' ? 'Nova Studio · GitHub 更新测试版 · 未签名' : '影像工作台 · 本地离线测试版 · 完整功能验收中', webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    additionalArguments: ['--nova-agent-enabled=' + features.agent, '--nova-cdp-enabled=' + features.browserAutomation],
  } });
  constrainNavigation(mainWindow.webContents, origin);
  mainWindow.webContents.on('will-prevent-unload', event => {
    if (!mainWindow || stopping) { event.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(mainWindow, { type: 'warning', title: '确认关闭', message: '页面正在处理数据，确定要关闭吗？', detail: '未完成的导入/导出操作将会中断。', buttons: ['仍要关闭', '取消'], defaultId: 1, cancelId: 1 });
    if (choice === 0) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('close', event => { if (updates?.preparing && !allowQuit) event.preventDefault(); });
  void mainWindow.loadURL(origin + '/');
}
async function start() {
  const port = await resolveBackendPort(Number(process.env.NOVA_BACKEND_PORT || 31207));
  const origin = 'http://127.0.0.1:' + port;
  const token = randomBytes(32).toString('hex');
  prepareBackendEnv(port);
  const features = { agent: false, browserAutomation: false, serviceWorker: false };
  configureDesktopSession({ origin, token });
  network = installNetworkPolicy(globalThis, { backendOrigin: origin, proxyFetch: (...args) => electronNet.fetch(...args), mode: process.env.NOVA_NETWORK_MODE || 'direct' });
  const policy = createSessionPolicy({ origin, token, getWebContents: () => mainWindow?.webContents });
  // Keep IndexedDB/localStorage intact. Desktop has no reason to grant session authority to PWA workers.
  await session.defaultSession.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] });
  detachSession = policy.attach(session.defaultSession);
  ipc = registerDesktopIpc({ ipcMain, dialog, shell, getWindow: () => mainWindow, policy, getAssetService: () => backend?.storage, getConnectionService: () => backend?.connections, getUpdateService: () => updates, getUpdateGate: () => backend?.updateGate, runtimeInfo: () => ({ version: app.getVersion(), storageMode: dataPolicy.mode, features }) });
  configureConnectionHost(db => createCredentialVault({ db, safeStorage }));
  backend = require('../backend/server');
  await backend.ready;
  updates = createUpdateService({ policy: readRuntimePolicy({ app, dataMode: dataPolicy.mode }), currentVersion: app.getVersion(),
    createUpdater() { const updater = new (require('electron-updater').NsisUpdater)(); installerLaunch = attachInstallerLaunchProof(updater); return updater; },
    send(channel, value) { const contents = mainWindow?.webContents; if (contents && policy.isTrustedSender({ sender: contents, senderFrame: contents.mainFrame })) contents.send(channel, value); },
    prepareBackend: () => backend.prepareForUpdate(), releaseBackend: () => backend.releaseUpdate(), closeBackend: () => backend.shutdownForUpdate(), onClosedFailure: () => { void reportUpdateFailure(); },
  });
  const response = await fetch(origin + '/api/nova/config', { headers: { [SESSION_HEADER]: token }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Desktop backend authorization failed');
  await response.arrayBuffer();
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow(origin, features);
  // One service per primary process. Window recreation and second-instance never call startup.
  setImmediate(() => { if (!stopping) void updates.startup(); });
  app.on('activate', () => { if (!stopping && BrowserWindow.getAllWindows().length === 0) createWindow(origin, features); });
}
if (initializationFailure) {
  void app.whenReady().then(() => { reportStartupFailure({dialog,error:initializationFailure}); app.exit(1); });
} else if (!primary) app.exit(0);
else {
  const updateQuit = createUpdateQuitHandler({ getUpdates: () => updates, getLaunchProof: () => installerLaunch,
    closeHost() { stopping = true; revokeDesktopSession(); network?.abortPending(); ipc?.dispose(); detachSession?.(); network?.dispose(); },
    quit() { allowQuit = true; app.quit(); }, onFailure() { void reportUpdateFailure(); },
  });
  // Desktop DevTools remains an explicit loopback-only test/debug switch.
  if (String(process.env.NOVA_ELECTRON_CDP_ENABLED || 'false').toLowerCase() === 'true') {
    const port = Number(process.env.NOVA_ELECTRON_CDP_PORT || 9333);
    if (!Number.isInteger(port) || port < 1 || port > 65535) initializationFailure = new Error('Invalid debug port');
    app.commandLine.appendSwitch('remote-debugging-port', String(port));
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  }
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (allowQuit) return;
    if (updateQuit.handle(event)) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    updates?.dispose();
    void cleanup().catch(() => { exitCode = 1; console.error('Desktop resource cleanup failed'); }).finally(() => { allowQuit = true; app.exit(exitCode); });
  });
  app.whenReady().then(() => { if(initializationFailure) throw initializationFailure; return start(); }).catch(error => { exitCode = 1; reportStartupFailure({dialog,error}); app.quit(); });
}
