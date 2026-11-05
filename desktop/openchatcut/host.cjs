'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { loopbackOrigin, editorPath, validateViewport } = require('./policy.cjs');
const { createEditorView } = require('./view.cjs');
const { performance } = require('node:perf_hooks');
const { classifyText, errorFields, SERVICE_PHASES } = require('./diagnostic-fields.cjs');
const { normalizeEditorSettings } = require('../../backend/storage/editor-settings');

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
  startTimeoutMs, getSettings = () => null, stopTimeoutMs = 2000, sendState = () => {}, diagnostics,
}) {
  let child = null, inFlight = null, disposed = false, generation = 0;
  let finishPending = null, closing = null;
  let state = { phase: 'idle', available: false, engineCommit: ENGINE_COMMIT };
  let activeAttempt;
  const processAttempts = new WeakMap();
  function log(attempt,event,fields={}) {if(!attempt)return;try{attempt.record(event,{stage:attempt.stage,stageElapsedMs:Math.max(0,Math.round(performance.now()-attempt.entered)),...fields});}catch{/* Diagnostics must never affect editing. */}}
  function enter(attempt,stage){attempt.stage=stage;attempt.entered=performance.now();}
  function recordStderr(attempt){if(attempt.stderr?.bytes&&!attempt.stderr.recorded){attempt.stderr.recorded=true;log(attempt,'service_stderr',{stderrBytes:attempt.stderr.bytes,...classifyText(attempt.stderr.text)});}}
  const view = createView({ electron, getWindow, dataDirectory,
    onDiagnostic(event,fields){if(disposed||!activeAttempt)return;if(event==='page_load_started')enter(activeAttempt,'page-load');if(event==='shell_wait_started')enter(activeAttempt,'shell-ready');log(activeAttempt,event,fields);},
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
  function fail(code, phase = 'failed') { log(activeAttempt,'startup_failed',{code:safeCode(code)});setState(phase, code); return { ok: false, code: safeCode(code), state: { ...state } }; }
  function preflight(attempt) {
    log(attempt,'preflight_started');
    try {
      const checked = inspect();
      if (!checked || !checked.available || checked.engineCommit !== ENGINE_COMMIT) {
        setState('unavailable', checked?.engineCommit && checked.engineCommit !== ENGINE_COMMIT ? 'EDITOR_VERSION_MISMATCH' : checked?.code, false);
        if (!state.code) setState('unavailable', 'EDITOR_RUNTIME_UNAVAILABLE', false);
        log(attempt,'preflight_failed',{code:state.code});
        return null;
      }
      log(attempt,'preflight_completed');return checked;
    } catch(error) { log(attempt,'preflight_failed',{code:'EDITOR_RUNTIME_UNAVAILABLE',...errorFields(error)});setState('unavailable', 'EDITOR_RUNTIME_UNAVAILABLE', false); return null; }
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
    const attempt=processAttempts.get(processToStop);if(attempt){enter(attempt,'stop');log(attempt,'stop_requested');}
    await new Promise(resolve => {
      let timer,completed=false;
      const finished = () => { if(completed)return;completed=true;clearTimeout(timer); processToStop.removeListener('exit', finished);log(attempt,'stop_completed'); resolve(); };
      processToStop.once('exit', finished);
      timer = setTimeout(() => { log(attempt,'service_force_killed');try { processToStop.kill(); } catch { /* Already gone. */ } finished(); }, stopTimeoutMs);
      try {
        if (processToStop.connected !== false) processToStop.send({ type: 'openchatcut:stop' }, error => { if (error) { try { processToStop.kill(); } catch {} } });
        else processToStop.kill();
      } catch { try { processToStop.kill(); } catch {} }
    });
  }

  async function start() {
    // Snapshot once per actual launch; changes never reset an in-flight timer.
    let settings;try{settings=getSettings();}catch{}
    const timeoutMs=startTimeoutMs ?? normalizeEditorSettings(settings).startupTimeoutSeconds*1000;
    let record=()=>{};try{record=diagnostics?.begin?.()||record;}catch{}
    const attempt={record,stage:'preflight',entered:performance.now(),phases:new Set(),stderr:{bytes:0,text:'',recorded:false}};activeAttempt=attempt;
    log(attempt,'open_requested',{deadlineMs:timeoutMs});
    const checked = preflight(attempt);
    if (!checked) return { ok: false, code: state.code, state: { ...state } };
    setState('starting', undefined, true);
    const epoch = ++generation;
    let processToStart;
    try {
      const servicePath = checked.servicePath || checked.paths?.serviceEntry;
      if (!path.isAbsolute(servicePath || '')) return fail('EDITOR_RUNTIME_UNAVAILABLE', 'unavailable');
      const env = environment({ dataDirectory, parentEnv: process.env,
        distDirectory: checked.distDir || checked.paths?.distDir, ffmpegPath: checked.ffmpegPath });
      enter(attempt,'spawn');log(attempt,'service_spawn_started');
      processToStart = forkService(servicePath, [], {
        execPath: process.execPath, execArgv: [],
        cwd: checked.workingDirectory || checked.sourceRoot || checked.paths?.sourceRoot,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      child = processToStart;
      processAttempts.set(processToStart,attempt);enter(attempt,'service-start');
      processToStart.once('spawn',()=>log(attempt,'service_spawned'));
      processToStart.stderr?.on('data',bytes=>{attempt.stderr.bytes=Math.min(Number.MAX_SAFE_INTEGER,attempt.stderr.bytes+bytes.length);if(attempt.stderr.text.length<16384)attempt.stderr.text+=String(bytes).slice(0,16384-attempt.stderr.text.length);});
    } catch(error) { log(attempt,'service_error',errorFields(error));return fail('EDITOR_SERVICE_FAILED'); }

    return new Promise(resolve => {
      let settled = false, receivedReady = false;
      const timer = setTimeout(() => {log(attempt,'startup_timeout',{deadlineMs:timeoutMs,servicePhase:attempt.lastServicePhase});recordStderr(attempt);settleFailure('EDITOR_START_TIMEOUT');}, timeoutMs);
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
        if(message.type==='openchatcut:phase'){if(!SERVICE_PHASES.has(message.phase)||attempt.phases.has(message.phase))return;attempt.phases.add(message.phase);attempt.lastServicePhase=message.phase;log(attempt,'service_phase',{servicePhase:message.phase,serviceElapsedMs:message.elapsedMs});return;}
        if (message.type === 'openchatcut:failed') {log(attempt,'service_error',errorFields({name:message.errorName,code:message.systemCode})); settleFailure(message.code || 'EDITOR_SERVICE_FAILED'); return; }
        if (message.type !== 'openchatcut:ready' || receivedReady) return;
        receivedReady = true;
        const origin = loopbackOrigin(message.origin), route = editorPath(message.editorPath);
        if (!origin || !route || (message.engineCommit && message.engineCommit !== ENGINE_COMMIT)) { settleFailure('EDITOR_INVALID_ORIGIN'); return; }
        log(attempt,'service_ready');enter(attempt,'page-load');
        Promise.resolve().then(() => view.load(origin, route)).then(() => {
          if (epoch !== generation || disposed) return;
          enter(attempt,'ready');log(attempt,'startup_completed');setState('ready', undefined, true);
          settle(reply());
        }, () => settleFailure('EDITOR_LOAD_FAILED'));
      });
      processToStart.once('error', error => {
        log(attempt,'service_error',errorFields(error));recordStderr(attempt);
        if (!settled) settleFailure('EDITOR_SERVICE_FAILED');
        else if (!disposed && child === processToStart) { generation++; child = null; view.reset(); setState('failed', 'EDITOR_SERVICE_EXITED'); }
      });
      processToStart.once('exit', (exitCode,signal) => {
        log(attempt,'service_exit',{exitCode,signal});recordStderr(attempt);
        if (!settled) settleFailure('EDITOR_SERVICE_EXITED');
        else if (!disposed && child === processToStart) { generation++; child = null; view.reset(); setState('failed', 'EDITOR_SERVICE_EXITED'); }
      });
    });
  }

  function open() {
    if (disposed) return Promise.resolve({ ok: false, code: 'EDITOR_STOPPED' });
    view.activate();
    if (state.phase === 'ready' && child) {log(activeAttempt,'open_reused');return Promise.resolve(reply());}
    if (inFlight) {log(activeAttempt,'open_coalesced');return inFlight;}
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
