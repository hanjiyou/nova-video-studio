'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, session, net: electronNet } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { resolveDataPolicy, resolveBackendPort } = require('./runtime.cjs');
const { installNetworkPolicy } = require('./network.cjs');
const { createSessionPolicy, constrainNavigation } = require('./session-policy.cjs');
const { registerDesktopIpc } = require('./ipc.cjs');
const { SESSION_HEADER, configureDesktopSession, revokeDesktopSession } = require('../backend/desktop-session');

const dataPolicy = resolveDataPolicy({ systemUserData: app.getPath('userData') });
fs.mkdirSync(dataPolicy.directory, { recursive: true });
app.setPath('userData', dataPolicy.directory);
// The lock is scoped to this data profile and acquired before any SQLite/queue is opened.
const primary = app.requestSingleInstanceLock();
let mainWindow = null;
let backend;
let network;
let ipc;
let detachSession;
let stopping = false;
let allowQuit = false;
let exitCode = 0;

function prepareBackendEnv(port) {
  process.env.PORT = String(port);
  process.env.HOSTNAME = '127.0.0.1';
  process.env.NODE_ENV = 'production';
  process.env.NOVA_TASK_DB = path.join(dataPolicy.directory, 'nova-tasks.sqlite');
  process.env.NOVA_IMAGE_DIR = path.join(dataPolicy.directory, 'nova-images');
  process.env.NOVA_CDP_DIR = path.join(dataPolicy.directory, 'cdp-products');
  process.env.NOVA_PLUGIN_MEDIA_DIR = path.join(dataPolicy.directory, 'plugin-media');
  process.env.NOVA_STORAGE_DIR = path.join(dataPolicy.directory, 'storage');
  process.env.NOVA_CDP_ENABLED ??= 'false';
  process.env.NOVA_CDP_LAUNCH_ENABLED ??= 'false';
  process.env.NOVA_AGENT_ENABLED ??= 'false';
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
  mainWindow = new BrowserWindow({ width: 1440, height: 900, title: 'Nova Image Studio', webPreferences: {
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
  void mainWindow.loadURL(origin + '/');
}
async function start() {
  const port = await resolveBackendPort(Number(process.env.NOVA_BACKEND_PORT || 31207));
  const origin = 'http://127.0.0.1:' + port;
  const token = randomBytes(32).toString('hex');
  prepareBackendEnv(port);
  const features = { agent: process.env.NOVA_AGENT_ENABLED === 'true', browserAutomation: process.env.NOVA_CDP_ENABLED === 'true', serviceWorker: false };
  configureDesktopSession({ origin, token });
  network = installNetworkPolicy(globalThis, { backendOrigin: origin, proxyFetch: (...args) => electronNet.fetch(...args), mode: process.env.NOVA_NETWORK_MODE || 'direct' });
  const policy = createSessionPolicy({ origin, token, getWebContents: () => mainWindow?.webContents });
  // Keep IndexedDB/localStorage intact. Desktop has no reason to grant session authority to PWA workers.
  await session.defaultSession.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] });
  detachSession = policy.attach(session.defaultSession);
  ipc = registerDesktopIpc({ ipcMain, dialog, getWindow: () => mainWindow, policy, getAssetService: () => backend?.storage, runtimeInfo: () => ({ version: app.getVersion(), storageMode: dataPolicy.mode, features }) });
  backend = require('../backend/server');
  await backend.ready;
  const response = await fetch(origin + '/api/nova/config', { headers: { [SESSION_HEADER]: token }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Desktop backend authorization failed');
  await response.arrayBuffer();
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow(origin, features);
  app.on('activate', () => { if (!stopping && BrowserWindow.getAllWindows().length === 0) createWindow(origin, features); });
}
if (!primary) app.exit(0);
else {
  // Desktop DevTools remains an explicit loopback-only test/debug switch.
  if (String(process.env.NOVA_ELECTRON_CDP_ENABLED || 'false').toLowerCase() === 'true') {
    const port = Number(process.env.NOVA_ELECTRON_CDP_PORT || 9333);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid NOVA_ELECTRON_CDP_PORT');
    app.commandLine.appendSwitch('remote-debugging-port', String(port));
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  }
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (allowQuit) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void cleanup().catch(() => { exitCode = 1; console.error('Desktop resource cleanup failed'); }).finally(() => { allowQuit = true; app.exit(exitCode); });
  });
  app.whenReady().then(start).catch(error => { exitCode = 1; console.error('Nova Image Studio 启动失败：', error.message); app.quit(); });
}
