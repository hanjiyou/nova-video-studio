'use strict';
const { randomUUID } = require('node:crypto');
const { stable, compare } = require('./update-policy.cjs');
const { BASELINE_REASONS } = require('./update-diagnostics.cjs');
const MESSAGES = Object.freeze({ UPDATE_CHECK_FAILED: '暂时无法检查更新，请稍后手动重试。', UPDATE_DOWNLOAD_FAILED: '更新下载失败，现有应用仍可使用，请重试。', UPDATE_BUSY: '任务、文件或设置仍在处理中，请完成后重试。', UPDATE_SUBMISSION_PENDING: '请先核对本地提交记录，再重启安装。不会为更新重新创建任务。', UPDATE_UNSAVED_RESULT: '仍有本次运行中的结果尚未保存，请先在任务详情中完成结果下载，再重启安装。', UPDATE_SAVE_FAILED: '草稿或设置尚未确认保存，请检查后重试。', UPDATE_PREPARE_TIMEOUT: '保存确认超时，已停止安装准备，请稍后重试。', UPDATE_CLOSE_FAILED: '本机数据关闭未通过确认，未启动安装。记录已保留；已暂停的远端任务需在任务详情中继续查询。请稍后重试或重新打开应用。', UPDATE_INSTALL_FAILED: '安装程序未能启动。已下载更新保留，请重新打开应用后重试。', UPDATE_INVALID_STATE: '当前还不能执行此更新操作。', DATA_DIRECTORY_RESTART_UNPROVEN: '当前使用自定义资料目录，请使用原启动方式手动更新，避免重启后读取其他资料。' });
function failure(code) { return { ok: false, code, message: MESSAGES[code] || '更新操作未完成，请稍后重试。' }; }
function textNotes(value) {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value.map(n => typeof n?.note === 'string' ? n.note : '').join('\n') : '';
  return raw.replace(/<[^>]*>/g, '').replace(/https?:\/\/[^\s<>]+/gi, '[链接已隐藏]').replace(/[A-Za-z]:[\\/][^\s]+/g, '[路径已隐藏]').replace(/(?:bearer|token|authorization|api[_-]?key)\s*[:=]?\s*\S+/gi, '[敏感内容已隐藏]').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 6000);
}
function progress(p) { const safe = {}; for (const k of ['percent', 'transferred', 'total', 'bytesPerSecond']) if (typeof p?.[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0) safe[k] = k === 'percent' ? Math.min(100, p[k]) : p[k]; return safe; }
// Only pinned 6.8.11 logger literals are interpreted. Never return source text.
function classifyDifferentialFallback(value, { planReady = false, checksumMismatch = false } = {}) {
  const firstLine = typeof value === 'string' ? value.slice(0, 4096).split(/\r?\n/, 1)[0] : '';
  if (checksumMismatch || /^Error: sha512 checksum mismatch, expected /.test(firstLine)) return 'checksum_failed';
  // Match the old installer's fixed basename and the failing fs operation, not an arbitrary ENOENT in a URL/stack.
  const oldFile = /^Error: (ENOENT|EACCES|EPERM|EBUSY|EISDIR|ENOTDIR): [^\r\n]*, (?:open|read) '[^\r\n]*[\\/]installer\.exe'$/.exec(firstLine);
  if (oldFile) return oldFile[1] === 'ENOENT' ? 'old_installer_missing' : 'old_installer_unreadable';
  if (/^Error: (?:Blockmap ".+" is empty|Cannot parse blockmap ".+", error:|version is different \(.+\), full download is required|no file .+ in old blockmap|Internal error, size mismatch: downloadSize:)/.test(firstLine)) return 'blockmap_failed';
  // HTTP failures before the download plan concern the blockmaps; after it they concern transfer.
  if (/^HttpError: (?:[45]\d{2}\b|HTTP error:)/.test(firstLine) || /^Error: (?:Request timed out|response has been aborted by the server|Too many redirects \(> \d+\))$/.test(firstLine)) return planReady ? 'transfer_failed' : 'blockmap_failed';
  if (planReady && /^Error: (?:Server doesn't support Accept-Ranges \(response code \d+\)|Content-Type "multipart\/byteranges" is expected, but got ".*"|Response ends without calling any handlers)$/.test(firstLine)) return 'transfer_failed';
  return 'unknown';
}
function createUpdateService({ prepareDownload = async () => ({ trusted: true }), policy, currentVersion, createUpdater, send = () => {}, prepareBackend, releaseBackend, closeBackend, onClosedFailure = () => {}, timeoutMs = 15000, diagnostics }) {
  let state = { supported: policy.supported, testBuild: policy.metadata?.profile === 'github-test', currentVersion, phase: policy.supported ? 'idle' : 'unsupported', reason: policy.reason, installSupported: !!policy.installSupported, installReason: policy.installReason, notice: null, remoteMayContinue: false };
  let updater, started = false, checking, downloading, preparing, flushPending, backendClosed = false, installing = false, disposed = false;
  const noticed = new Set(), listeners = [];
  const record = (event, fields) => diagnostics?.record(event, fields);
  let progressBucket=-1, downloadAttempt;
  const failureEvent = code => code === 'UPDATE_CHECK_FAILED' ? 'check_failed' : code === 'UPDATE_DOWNLOAD_FAILED' ? 'download_failed' : code === 'UPDATE_INSTALL_FAILED' ? 'install_failed' : 'prepare_failed';
  const publish = patch => { state = { ...state, ...patch }; if (!disposed) send('nova:update-state', snapshot()); };
  const snapshot = () => structuredClone(state);
  const fail = (code, phase = 'error') => { if (code === 'UPDATE_DOWNLOAD_FAILED' && downloadAttempt) downloadAttempt.active = false; record(failureEvent(code),{code}); publish({ phase, error: failure(code), progress: undefined }); return { ...failure(code), state: snapshot() }; };
  function available(info) {
    if (!stable(info?.version) || compare(info.version, currentVersion) <= 0) return fail('UPDATE_CHECK_FAILED');
    record('available', {targetVersion:info.version});
    const next = { version: info.version, releaseNotes: textNotes(info.releaseNotes) };
    const notify = !noticed.has(info.version);
    if (notify) noticed.add(info.version);
    publish({ phase: 'available', update: next, progress: undefined, downloadMode: undefined, fallbackReason: undefined, baselineReason: undefined, error: undefined, notice: notify ? info.version : state.notice });
  }
  if (policy.supported) {
    updater = createUpdater();
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.autoRunAppAfterInstall = true;
    updater.disableWebInstaller = true; updater.disableDifferentialDownload = false; updater.allowPrerelease = false; updater.allowDowngrade = false;
    // Updater diagnostics may contain URLs, credentials or local paths. Public state uses only fixed codes.
    // Pinned 6.8.11 literals are classified and immediately discarded, never saved as text.
    const loggerEvent = value => {
      const attempt = downloadAttempt;
      if (typeof value !== 'string' || !attempt?.active || state.phase !== 'downloading') return;
      if (value.startsWith('Cannot download differentially, fallback to full download: ')) {
        if (state.downloadMode === 'full-fallback' || state.downloadMode === 'full') return;
        const fallbackReason = classifyDifferentialFallback(value.slice('Cannot download differentially, fallback to full download: '.length), attempt);
        record('differential_fallback', { fallbackReason });
        attempt.cacheReuseCandidate = false;
        progressBucket = -1;
        publish({ downloadMode: 'full-fallback', fallbackReason, progress: undefined });
      } else if (value.startsWith('sha512 checksum mismatch after differential download (')) {
        if (!attempt.checksumMismatch && ['differential-attempt', 'differential'].includes(state.downloadMode)) {
          attempt.checksumMismatch = true;
          record('differential_checksum_mismatch');
        }
      } else if (value.startsWith('Download block maps (old: "')) {
        if (['preparing', 'unknown'].includes(state.downloadMode)) {
          attempt.differentialStarted = true;
          attempt.cacheReuseCandidate = false;
          record('differential_started');
          publish({ downloadMode: 'differential-attempt' });
        }
      } else if (attempt.differentialStarted && /^Full: [\d,.]+ KB, To download: [\d,.]+ KB \(\d+%\)$/.test(value)) {
        // A plan is not a transfer: this log precedes opening the old installer.
        attempt.planReady = true;
      } else if (value.startsWith('Update has already been downloaded to ') && !attempt.sawProgress && !attempt.differentialStarted) {
        // Confirm only when update-downloaded follows; the prefix alone is not completion.
        attempt.cacheReuseCandidate = true;
      }
    };
    updater.logger = { info:loggerEvent, warn:loggerEvent, error:loggerEvent, debug() {} };
    function on(name, fn) { updater.on(name, fn); listeners.push([name, fn]); }
    on('update-available', info => { if (checking) available(info); });
    on('update-not-available', () => { if (checking) { record('no_update'); publish({ phase: 'idle', error: undefined }); } });
    on('download-progress', p => {
      const attempt = downloadAttempt;
      if (!downloading || !attempt?.active || state.phase !== 'downloading') return;
      const safe = progress(p), bucket = Math.floor((safe.percent || 0) / 10);
      attempt.sawProgress = true;
      attempt.cacheReuseCandidate = false;
      let downloadMode = state.downloadMode;
      if (attempt.differentialStarted && safe.transferred > 0 && downloadMode === 'differential-attempt') {
        downloadMode = 'differential'; record('differential_downloading');
      } else if (downloadMode === 'preparing') downloadMode = 'unknown';
      if (bucket !== progressBucket) {
        progressBucket = bucket;
        record('download_progress', { downloadMode, ...Object.fromEntries(Object.entries(safe).map(([k, v]) => [k, Math.round(v)])) });
      }
      publish({ phase: 'downloading', downloadMode, progress: safe });
    });
    on('update-downloaded', info => {
      const attempt = downloadAttempt;
      if (downloading && attempt?.active && state.phase === 'downloading' && state.update?.version === info?.version) {
        const downloadMode = attempt.cacheReuseCandidate ? 'cached' : state.downloadMode;
        if (downloadMode === 'cached') record('download_cache_reused');
        attempt.active = false;
        record('downloaded', { targetVersion: info.version, downloadMode });
        publish({ phase: 'downloaded', downloadMode, progress: undefined, error: undefined });
      }
    });
    on('error', error => {
      diagnostics?.error(installing || backendClosed ? 'install_failed' : downloading ? 'download_failed' : 'check_failed', error);
      if (installing || backendClosed) { fail('UPDATE_INSTALL_FAILED', 'closed-error'); onClosedFailure(); }
      else if (downloading && downloadAttempt?.active) fail('UPDATE_DOWNLOAD_FAILED');
      // Automatic checks fail quietly; their final status is still visible in settings.
    });
  }
  function check() {
    if (!policy.supported) return Promise.resolve(failure('UPDATE_UNSUPPORTED'));
    if (backendClosed || installing) return Promise.resolve(failure('UPDATE_INVALID_STATE'));
    if (checking) return checking;
    if (downloading || preparing || ['downloaded', 'installing', 'closed-error'].includes(state.phase)) return Promise.resolve(failure('UPDATE_INVALID_STATE'));
    diagnostics?.begin(); record('check_started');
    publish({ phase: 'checking', error: undefined, progress: undefined, downloadMode: undefined, fallbackReason: undefined, baselineReason: undefined });
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
    downloadAttempt = { active: true, differentialStarted: false, planReady: false, checksumMismatch: false, cacheReuseCandidate: false, sawProgress: false };
    progressBucket=-1; record('download_started',{targetVersion:state.update.version});
    publish({ phase: 'downloading', downloadMode: 'preparing', baselineReason: undefined, fallbackReason: undefined, progress: undefined, error: undefined, notice: null });
    downloading = Promise.resolve().then(async () => {
      let baseline;
      try { baseline = await prepareDownload(updater); } catch { baseline = { trusted: false, reason: 'unknown' }; }
      if (!downloadAttempt.active || disposed) throw Error();
      updater.disableDifferentialDownload = baseline?.trusted !== true;
      if (updater.disableDifferentialDownload) {
        const baselineReason = BASELINE_REASONS.has(baseline?.reason) ? baseline.reason : 'unknown';
        record('differential_unavailable', { baselineReason });
        publish({ downloadMode: 'full', baselineReason });
      }
      return updater.downloadUpdate();
    }).then(() => {
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
    dispose() { disposed = true; if (downloadAttempt) downloadAttempt.active = false; if (flushPending) flushPending.resolve(false); for (const [event, fn] of listeners) updater.removeListener(event, fn); },
  };
}
module.exports = { createUpdateService, textNotes, progress, failure, classifyDifferentialFallback };
