'use client';
import { useState, useSyncExternalStore } from 'react';
import type { AppUpdateState } from '@/lib/app-update';
import { updateUnsupportedMessage } from '@/lib/app-update';
import { hasUpdateBlockers, subscribeUpdateReadiness } from '@/lib/update-readiness';
export function UpdateNotice({ state, onOpen }: { state: AppUpdateState | null; onOpen: () => void }) {
  if (!state?.notice) return null;
  return <div className="wb-notice wb-update-notice" role="status"><div><strong>有新版本 {state.notice}</strong><p>可在设置中下载，完成后由你选择重启安装。</p></div><button type="button" onClick={onOpen}>查看更新</button><button type="button" aria-label="关闭更新提示" onClick={() => void window.novaDesktop?.dismissUpdateNotice().catch(() => {})}>稍后</button></div>;
}
export function AppUpdate({ state, onInstall }: { state: AppUpdateState | null; onInstall: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [transportError, setTransportError] = useState('');
  const blocked = useSyncExternalStore(subscribeUpdateReadiness, hasUpdateBlockers, () => true);
  async function run(operation: () => Promise<unknown> | undefined) { if (pending) return; setPending(true); setTransportError(''); try { await operation(); } catch { setTransportError('暂时无法执行更新操作，请稍后重试。'); } finally { setPending(false); } }
  const busy = pending || state && ['checking', 'downloading', 'preparing', 'installing', 'closed-error'].includes(state.phase);
  return <section className="wb-panel wb-app-update" aria-label="应用更新"><div className="wb-section-heading"><h2>应用更新</h2><span className="wb-local-pill">当前版本 {state?.currentVersion || '读取中'}</span></div>
    {!state ? <p className="wb-help">应用内更新仅在受支持的桌面安装版中提供。</p> : !state.supported ? <p className="wb-help">{updateUnsupportedMessage(state)}</p> : <>
      <p className="wb-help">每次启动后检查一次。下载和重启安装均由你决定。</p>
      {state.update && <div><h3>新版本 {state.update.version}</h3>{state.update.releaseNotes && <p className="wb-update-notes">{state.update.releaseNotes}</p>}</div>}
      {state.phase === 'idle' && <p role="status" className="wb-help">当前未发现可用的新版本。</p>}
      {state.phase === 'checking' && <p role="status">正在检查更新…</p>}
      {state.phase === 'downloading' && <div role="status"><p>正在下载更新{typeof state.progress?.percent === 'number' ? ` · ${Math.floor(state.progress.percent)}%` : '…'}</p><progress max={100} value={state.progress?.percent} /><p className="wb-help">应用会尽量复用已有下载；需要时会下载完整安装包。</p></div>}
      {state.phase === 'downloaded' && <p role="status">更新已下载。重启前将确认草稿保存并安全关闭本机数据。</p>}
      {(state.phase === 'downloaded' || state.phase === 'preparing') && <p className="wb-warning">重启会停止本机查询。远端任务可能继续生成或计费；原任务记录与占位会保留。</p>}
      {state.error && <p role="alert" className="wb-error">{state.error.message}</p>}
      {transportError && <p role="alert" className="wb-error">{transportError}</p>}
      {!state.installSupported && <p className="wb-help">当前使用自定义资料目录，请按原启动方式手动更新，避免重启后读取其他资料。</p>}
      {blocked && state.phase === 'downloaded' && <p className="wb-help">请先保存设置、完成当前操作并核对本地提交记录。</p>}
      <div className="wb-actions"><button type="button" disabled={!!busy || state.phase === 'downloaded'} onClick={() => void run(() => window.novaDesktop?.checkForUpdates())}>检查更新</button>
        {state.update && ['available', 'error'].includes(state.phase) && <button type="button" className="wb-primary" disabled={!!busy} onClick={() => void run(() => window.novaDesktop?.downloadUpdate())}>{state.error?.code === 'UPDATE_DOWNLOAD_FAILED' ? '重试下载' : '下载更新'}</button>}
        {state.phase === 'downloaded' && <><button type="button" className="wb-primary" disabled={pending || blocked || !state.installSupported} onClick={() => void run(onInstall)}>重启并安装</button><button type="button" onClick={() => void window.novaDesktop?.dismissUpdateNotice().catch(() => {})}>稍后</button></>}
      </div>
    </>}
  </section>;
}
