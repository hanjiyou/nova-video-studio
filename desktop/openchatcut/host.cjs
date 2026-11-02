'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { loopbackOrigin, editorPath, validateViewport } = require('./policy.cjs');
const { createEditorView } = require('./view.cjs');

const ENGINE_COMMIT = '7fa4b7903e7ebecf832a36249f0c0c755200cc17';
const CODES = new Set([
  'EDITOR_RUNTIME_UNAVAILABLE', 'EDITOR_DEPENDENCIES_MISSING', 'EDITOR_BUILD_MISSING',
  'EDITOR_VERSION_MISMATCH', 'EDITOR_NODE_UNSUPPORTED', 'EDITOR_SERVICE_FAILED',
  'EDITOR_SERVICE_EXITED', 'EDITOR_START_TIMEOUT', 'EDITOR_INVALID_ORIGIN',
  'EDITOR_LOAD_FAILED', 'EDITOR_RENDERER_EXITED', 'EDITOR_WINDOW_UNAVAILABLE',
  'EDITOR_INVALID_VIEWPORT', 'EDITOR_STOPPED', 'EDITOR_CREDENTIALS_NOT_READY',
  'EDITOR_RUNTIME_NOT_PACKAGED', 'EDITOR_SOURCE_MISSING', 'EDITOR_RUNTIME_INVALID',
  'EDITOR_BUILD_INVALID', 'EDITOR_PRECHECK_FAILED', 'EDITOR_START_FAILED',
  'EDITOR_CREDENTIAL_BRIDGE_NOT_READY',
]);
const safeCode = value => CODES.has(value) ? value : 'EDITOR_RUNTIME_UNAVAILABLE';

function createEditorHost({
  electron, getWindow, dataDirectory, repositoryRoot = path.resolve(__dirname, '../..'),
  resourcesPath = process.resourcesPath, packaged = false,
  inspectRuntime, createEnvironment, forkService = fork, createView = createEditorView,
  startTimeoutMs = 30000, stopTimeoutMs = 2000, sendState = () => {},
}) {
  let child = null, inFlight = null, disposed = false, generation = 0;
  let finishPending = null, closing = null;
  let state = { phase: 'idle', available: false, engineCommit: ENGINE_COMMIT };
  const view = createView({ electron, getWindow, dataDirectory,
    onFailure: code => {
      if (disposed) return;
      generation++;
      const failedChild = child;
      child = null;
      setState('failed', code);
      finishPending?.(safeCode(code));
      view.reset();
      void stopChild(failedChild);
    },
  });
  const runtimeModule = () => require('../../scripts/openchatcut-runtime.cjs');
  const inspect = inspectRuntime || (() => runtimeModule().inspectOpenChatCutRuntime({ repositoryRoot, resourcesPath, packaged, nodeVersion: process.versions.node }));
  const environment = createEnvironment || (options => runtimeModule().createOpenChatCutServiceEnvironment(options));

  function setState(phase, code, available = state.available) {
    state = { phase, available, engineCommit: ENGINE_COMMIT, ...(code ? { code: safeCode(code) } : {}) };
    try { sendState({ ...state }); } catch { /* A closed Nova window is not an editor failure. */ }
  }
  function reply() { return { ok: true, state: { ...state } }; }
  function fail(code, phase = 'failed') { setState(phase, code); return { ok: false, code: safeCode(code), state: { ...state } }; }
  function preflight() {
    try {
      const checked = inspect();
      if (!checked || !checked.available || checked.engineCommit !== ENGINE_COMMIT) {
        setState('unavailable', checked?.engineCommit && checked.engineCommit !== ENGINE_COMMIT ? 'EDITOR_VERSION_MISMATCH' : checked?.code, false);
        if (!state.code) setState('unavailable', 'EDITOR_RUNTIME_UNAVAILABLE', false);
        return null;
      }
      return checked;
    } catch { setState('unavailable', 'EDITOR_RUNTIME_UNAVAILABLE', false); return null; }
  }

  function stateSnapshot() {
    if (!disposed && ['idle', 'unavailable', 'stopped'].includes(state.phase) && !child) {
      if (preflight()) setState('idle', undefined, true);
    }
    return reply();
  }

  async function stopChild(processToStop) {
    if (!processToStop) return;
    if (processToStop.exitCode !== null && processToStop.exitCode !== undefined) return;
    await new Promise(resolve => {
      let timer;
      const finished = () => { clearTimeout(timer); processToStop.removeListener('exit', finished); resolve(); };
      processToStop.once('exit', finished);
      timer = setTimeout(() => { try { processToStop.kill(); } catch { /* Already gone. */ } finished(); }, stopTimeoutMs);
      try {
        if (processToStop.connected !== false) processToStop.send({ type: 'openchatcut:stop' }, error => { if (error) { try { processToStop.kill(); } catch {} } });
        else processToStop.kill();
      } catch { try { processToStop.kill(); } catch {} }
    });
  }

  async function start() {
    const checked = preflight();
    if (!checked) return { ok: false, code: state.code, state: { ...state } };
    setState('starting', undefined, true);
    const epoch = ++generation;
    let processToStart;
    try {
      const servicePath = checked.servicePath || checked.paths?.serviceEntry;
      if (!path.isAbsolute(servicePath || '')) return fail('EDITOR_RUNTIME_UNAVAILABLE', 'unavailable');
      const env = environment({ dataDirectory, parentEnv: process.env,
        distDirectory: checked.distDir || checked.paths?.distDir, ffmpegPath: checked.ffmpegPath });
      processToStart = forkService(servicePath, [], {
        execPath: process.execPath, execArgv: [],
        cwd: checked.workingDirectory || checked.sourceRoot || checked.paths?.sourceRoot,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child = processToStart;
    } catch { return fail('EDITOR_SERVICE_FAILED'); }

    return new Promise(resolve => {
      let settled = false, receivedReady = false;
      const timer = setTimeout(() => settleFailure('EDITOR_START_TIMEOUT'), startTimeoutMs);
      const settle = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); finishPending = null; resolve(result);
      };
      finishPending = (code = 'EDITOR_STOPPED') => settle({ ok: false, code, state: { ...state } });
      const settleFailure = code => {
        if (settled || epoch !== generation || disposed) return;
        generation++;
        view.reset();
        if (child === processToStart) child = null;
        const result = fail(code);
        void stopChild(processToStart);
        settle(result);
      };
      processToStart.on('message', message => {
        if (epoch !== generation || disposed || settled || !message || typeof message !== 'object') return;
        if (message.type === 'openchatcut:failed') { settleFailure(message.code || 'EDITOR_SERVICE_FAILED'); return; }
        if (message.type !== 'openchatcut:ready' || receivedReady) return;
        receivedReady = true;
        const origin = loopbackOrigin(message.origin), route = editorPath(message.editorPath);
        if (!origin || !route || (message.engineCommit && message.engineCommit !== ENGINE_COMMIT)) { settleFailure('EDITOR_INVALID_ORIGIN'); return; }
        Promise.resolve().then(() => view.load(origin, route)).then(() => {
          if (epoch !== generation || disposed) return;
          setState('ready', undefined, true);
          settle(reply());
        }, () => settleFailure('EDITOR_LOAD_FAILED'));
      });
      processToStart.once('error', () => {
        if (!settled) settleFailure('EDITOR_SERVICE_FAILED');
        else if (!disposed && child === processToStart) { generation++; child = null; view.reset(); setState('failed', 'EDITOR_SERVICE_EXITED'); }
      });
      processToStart.once('exit', () => {
        if (!settled) settleFailure('EDITOR_SERVICE_EXITED');
        else if (!disposed && child === processToStart) { generation++; child = null; view.reset(); setState('failed', 'EDITOR_SERVICE_EXITED'); }
      });
    });
  }

  function open() {
    if (disposed) return Promise.resolve({ ok: false, code: 'EDITOR_STOPPED' });
    view.activate();
    if (state.phase === 'ready' && child) return Promise.resolve(reply());
    if (inFlight) return inFlight;
    inFlight = start().finally(() => { inFlight = null; });
    return inFlight;
  }
  function hide() { view.hide(); return { ok: true }; }
  function viewport(input) {
    const value = validateViewport(input);
    if (!value) return { ok: false, code: 'EDITOR_INVALID_VIEWPORT' };
    view.setViewport(value);
    if (!value.visible) view.hide();
    return { ok: true };
  }
  async function dispose() {
    if (disposed) return;
    disposed = true; generation++;
    view.dispose();
    const stoppingChild = child;
    child = null;
    setState('stopped', undefined, false);
    finishPending?.();
    await stopChild(stoppingChild);
  }
  return {
    state: stateSnapshot, open, viewport, hide, dispose,
    hasEditingContext: () => Boolean(child || inFlight || view.hasView()),
    requestClose() {
      if (closing) return closing;
      closing = (async () => {
        if (!await view.requestClose()) return false;
        generation++;
        const stoppingChild = child;
        child = null;
        view.reset();
        setState('stopped', undefined, false);
        finishPending?.();
        await stopChild(stoppingChild);
        return true;
      })().finally(() => { closing = null; });
      return closing;
    },
    // The initial integration has no verified native-page flush handshake yet.
    // Refuse installation while an editing context exists instead of claiming save.
    prepareForUpdate() {
      if (child || inFlight || view.hasView()) throw Object.assign(new Error('UPDATE_BUSY'), { code: 'UPDATE_BUSY' });
      hide();
    },
  };
}
module.exports = { createEditorHost, ENGINE_COMMIT };
