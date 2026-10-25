'use strict';
const { randomUUID } = require('node:crypto');
const { stable, compare } = require('./update-policy.cjs');
const MESSAGES = Object.freeze({ UPDATE_CHECK_FAILED: '暂时无法检查更新，请稍后手动重试。', UPDATE_DOWNLOAD_FAILED: '更新下载失败，现有应用仍可使用，请重试。', UPDATE_BUSY: '任务、文件或设置仍在处理中，请完成后重试。', UPDATE_SUBMISSION_PENDING: '请先核对本地提交记录，再重启安装。不会为更新重新创建任务。', UPDATE_UNSAVED_RESULT: '仍有本次运行中的结果尚未保存，请先在任务详情中完成结果下载，再重启安装。', UPDATE_SAVE_FAILED: '草稿或设置尚未确认保存，请检查后重试。', UPDATE_PREPARE_TIMEOUT: '保存确认超时，已停止安装准备，请稍后重试。', UPDATE_CLOSE_FAILED: '本机数据关闭未通过确认，未启动安装。记录已保留；已暂停的远端任务需在任务详情中继续查询。请稍后重试或重新打开应用。', UPDATE_INSTALL_FAILED: '安装程序未能启动。已下载更新保留，请重新打开应用后重试。', UPDATE_INVALID_STATE: '当前还不能执行此更新操作。', DATA_DIRECTORY_RESTART_UNPROVEN: '当前使用自定义资料目录，请使用原启动方式手动更新，避免重启后读取其他资料。' });
function failure(code) { return { ok: false, code, message: MESSAGES[code] || '更新操作未完成，请稍后重试。' }; }
function textNotes(value) {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value.map(n => typeof n?.note === 'string' ? n.note : '').join('\n') : '';
  return raw.replace(/<[^>]*>/g, '').replace(/https?:\/\/[^\s<>]+/gi, '[链接已隐藏]').replace(/[A-Za-z]:[\\/][^\s]+/g, '[路径已隐藏]').replace(/(?:bearer|token|authorization|api[_-]?key)\s*[:=]?\s*\S+/gi, '[敏感内容已隐藏]').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 6000);
}
function progress(p) { const safe = {}; for (const k of ['percent', 'transferred', 'total', 'bytesPerSecond']) if (typeof p?.[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0) safe[k] = k === 'percent' ? Math.min(100, p[k]) : p[k]; return safe; }
function createUpdateService({ policy, currentVersion, createUpdater, send = () => {}, prepareBackend, releaseBackend, closeBackend, onClosedFailure = () => {}, timeoutMs = 15000, diagnostics }) {
  let state = { supported: policy.supported, testBuild: policy.metadata?.profile === 'github-test', currentVersion, phase: policy.supported ? 'idle' : 'unsupported', reason: policy.reason, installSupported: !!policy.installSupported, installReason: policy.installReason, notice: null, remoteMayContinue: false };
  let updater, started = false, checking, downloading, preparing, flushPending, backendClosed = false, installing = false, disposed = false;
  const noticed = new Set(), listeners = [];
  const record = (event, fields) => diagnostics?.record(event, fields);
  let progressBucket=-1;
  const failureEvent = code => code === 'UPDATE_CHECK_FAILED' ? 'check_failed' : code === 'UPDATE_DOWNLOAD_FAILED' ? 'download_failed' : code === 'UPDATE_INSTALL_FAILED' ? 'install_failed' : 'prepare_failed';
  const publish = patch => { state = { ...state, ...patch }; if (!disposed) send('nova:update-state', snapshot()); };
  const snapshot = () => structuredClone(state);
  const fail = (code, phase = 'error') => { record(failureEvent(code),{code}); publish({ phase, error: failure(code), progress: undefined }); return { ...failure(code), state: snapshot() }; };
  function available(info) {
    if (!stable(info?.version) || compare(info.version, currentVersion) <= 0) return fail('UPDATE_CHECK_FAILED');
    record('available', {targetVersion:info.version});
    const next = { version: info.version, releaseNotes: textNotes(info.releaseNotes) };
    const notify = !noticed.has(info.version);
    if (notify) noticed.add(info.version);
    publish({ phase: 'available', update: next, progress: undefined, error: undefined, notice: notify ? info.version : state.notice });
  }
  if (policy.supported) {
    updater = createUpdater();
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.autoRunAppAfterInstall = true;
    updater.disableWebInstaller = true; updater.disableDifferentialDownload = false; updater.allowPrerelease = false; updater.allowDowngrade = false;
    // Updater diagnostics may contain URLs, credentials or local paths. Public state uses only fixed codes.
    // Pinned 6.8.11 literals are classified and immediately discarded, never saved as text.
    const loggerEvent = value => {
      if(typeof value!=='string')return;
      if(value.startsWith('Cannot download differentially, fallback to full download: '))record('differential_fallback');
      else if(value.startsWith('sha512 checksum mismatch after differential download ('))record('differential_checksum_mismatch');
      else if(value.startsWith('Download block maps (old: "'))record('differential_started');
    };
    updater.logger = { info:loggerEvent, warn:loggerEvent, error:loggerEvent, debug() {} };
    function on(name, fn) { updater.on(name, fn); listeners.push([name, fn]); }
    on('update-available', info => { if (checking) available(info); });
    on('update-not-available', () => { if (checking) { record('no_update'); publish({ phase: 'idle', error: undefined }); } });
    on('download-progress', p => { if (downloading) { const safe=progress(p), bucket=Math.floor((safe.percent||0)/10); if(bucket!==progressBucket){progressBucket=bucket;record('download_progress',Object.fromEntries(Object.entries(safe).map(([k,v])=>[k,Math.round(v)])));} publish({ phase: 'downloading', progress:safe }); } });
    on('update-downloaded', info => { if (downloading && state.update?.version === info?.version) { record('downloaded',{targetVersion:info.version}); publish({ phase: 'downloaded', progress: undefined, error: undefined }); } });
    on('error', error => {
      diagnostics?.error(installing || backendClosed ? 'install_failed' : downloading ? 'download_failed' : 'check_failed', error);
      if (installing || backendClosed) { fail('UPDATE_INSTALL_FAILED', 'closed-error'); onClosedFailure(); }
      else if (downloading) fail('UPDATE_DOWNLOAD_FAILED');
      // Automatic checks fail quietly; their final status is still visible in settings.
    });
  }
  function check() {
    if (!policy.supported) return Promise.resolve(failure('UPDATE_UNSUPPORTED'));
    if (backendClosed || installing) return Promise.resolve(failure('UPDATE_INVALID_STATE'));
    if (checking) return checking;
    if (downloading || preparing || ['downloaded', 'installing', 'closed-error'].includes(state.phase)) return Promise.resolve(failure('UPDATE_INVALID_STATE'));
    diagnostics?.begin(); record('check_started');
    publish({ phase: 'checking', error: undefined });
    checking = Promise.resolve().then(() => updater.checkForUpdates()).then(result => {
      if (!result || !stable(result.updateInfo?.version)) throw Error();
      if (compare(result.updateInfo.version, currentVersion) > 0 && state.phase === 'checking') available(result.updateInfo);
      if (state.phase === 'checking') publish({ phase: 'idle' });
      return { ok: true, state: snapshot() };
    }).catch(error => { diagnostics?.error('check_failed',error); return fail('UPDATE_CHECK_FAILED'); }).finally(() => { checking = null; });
    return checking;
  }
  function download() {
    if (backendClosed || installing) return Promise.resolve(failure('UPDATE_INVALID_STATE'));
    if (downloading) return downloading;
    if (!policy.supported || checking || preparing || !state.update || !['available', 'error'].includes(state.phase)) return Promise.resolve(failure('UPDATE_INVALID_STATE'));
    progressBucket=-1; record('download_started',{targetVersion:state.update.version});
    publish({ phase: 'downloading', error: undefined, notice: null });
    downloading = Promise.resolve().then(() => updater.downloadUpdate()).then(() => {
      if (state.phase !== 'downloaded') throw Error();
      return { ok: true, state: snapshot() };
    }).catch(error => { diagnostics?.error('download_failed',error); return fail('UPDATE_DOWNLOAD_FAILED'); }).finally(() => { downloading = null; });
    return downloading;
  }
  function requestFlush() {
    return new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { flushPending = null; reject(failure('UPDATE_PREPARE_TIMEOUT')); }, timeoutMs);
      flushPending = { id, resolve: ok => { clearTimeout(timer); flushPending = null; ok ? resolve() : reject(failure('UPDATE_SAVE_FAILED')); } };
      record('flush_requested'); send('nova:update-flush', { id });
    });
  }
  function install() {
    if (preparing) return preparing;
    if (!policy.installSupported) return Promise.resolve(failure(policy.installReason || 'UPDATE_UNSUPPORTED'));
    if (state.phase !== 'downloaded' || downloading || checking) return Promise.resolve(failure('UPDATE_INVALID_STATE'));
    preparing = Promise.resolve().then(async () => {
      record('prepare_started');
      const prepared = await prepareBackend(); record('backend_prepared');
      publish({ phase: 'preparing', error: undefined, remoteMayContinue: !!prepared.remoteMayContinue });
      await requestFlush(); record('flush_complete');
      record('backend_close_started');
      const proof = await closeBackend();
      if (proof?.databaseClosed !== true || proof?.checkpointComplete !== true) throw failure('UPDATE_CLOSE_FAILED');
      record('backend_closed');
      backendClosed = true; installing = true;
      publish({ phase: 'installing' });
      record('install_requested',{targetVersion:state.update.version,interactive:true,windowHidden:false});
      updater.quitAndInstall(false, true);
      return { ok: true };
    }).catch(error => {
      diagnostics?.error(backendClosed?'install_failed':'prepare_failed',error);
      if (backendClosed) { const result = fail('UPDATE_INSTALL_FAILED', 'closed-error'); onClosedFailure(); return result; }
      // closeBackend marks an unrecoverable partial close explicitly; never pretend it resumed.
      if (error?.closed) { backendClosed = true; const result = fail('UPDATE_CLOSE_FAILED', 'closed-error'); onClosedFailure(); return result; }
      releaseBackend();
      const code = ['UPDATE_BUSY', 'UPDATE_UNSAVED_RESULT', 'UPDATE_SUBMISSION_PENDING', 'UPDATE_SAVE_FAILED', 'UPDATE_PREPARE_TIMEOUT'].includes(error?.code) ? error.code : 'UPDATE_CLOSE_FAILED';
      return fail(code, 'downloaded');
    }).finally(() => { preparing = null; });
    return preparing;
  }
  return {
    snapshot, check, download, install,
    startup() { if (started) return checking || Promise.resolve(); started = true; return check(); },
    dismiss() { publish({ notice: null }); return { ok: true }; },
    acknowledgeFlush(value) { if (!value || Object.keys(value).sort().join('|') !== 'id|ok' || typeof value.ok !== 'boolean' || !flushPending || flushPending.id !== value.id) return failure('UPDATE_INVALID_STATE'); if(!value.ok)record('flush_failed'); flushPending.resolve(value.ok); return { ok: true }; },
    get installing() { return installing; },
    get preparing() { return !!preparing; },
    get backendClosed() { return backendClosed; },
    dispose() { disposed = true; if (flushPending) flushPending.resolve(false); for (const [event, fn] of listeners) updater.removeListener(event, fn); },
  };
}
module.exports = { createUpdateService, textNotes, progress, failure };
