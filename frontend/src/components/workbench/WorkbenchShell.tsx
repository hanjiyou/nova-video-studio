'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Film, FolderHeart, Image as ImageIcon, Settings, Sparkles } from 'lucide-react';
import { ConnectionForm } from './ConnectionForm';
import { DefaultSettings } from './DefaultSettings';
import { DraftEditor, VIDEO_MODES } from './DraftEditor';
import { useWorkbenchDrafts } from '@/hooks/useWorkbenchDrafts';
import { ConnectionModels, ConnectionSummary, getConnectionModels, getCurrentConnection } from '@/lib/connection-client';
import { connectionMessage, DRAFT_MODES, DraftMode, getLocalHistory, getSetting, localErrorMessage, OnboardingPreferences, putSetting, PRODUCT_FEATURES, Setting, WorkbenchPage, WORKBENCH_PAGES, WorkspacePreferences } from '@/lib/workbench-client';
const PAGE_LABELS: Record<WorkbenchPage, string> = { image: '图片生成', video: '视频生成', library: '作品库', settings: '设置' };
const PAGE_ICONS = { image: ImageIcon, video: Film, library: FolderHeart, settings: Settings };
const STATE_LABELS: Record<string, string> = { local_queued: '本地排队', submitting: '提交中', submission_unknown: '提交结果待核对', remote_queued: '远端排队', generating: '生成中', polling_paused: '查询已暂停', remote_completed: '等待下载', downloading: '下载中', download_failed: '下载失败', completed: '已保存', failed: '失败', local_cancelled: '本地排队已取消', remote_cancelled: '远端已取消' };
export function WorkbenchShell() {
  const drafts = useWorkbenchDrafts();
  const loadDrafts = drafts.load;
  const [ready, setReady] = useState(false), [bootError, setBootError] = useState('');
  const [page, setPage] = useState<WorkbenchPage>('image');
  const [mode, setMode] = useState<DraftMode>('image.text');
  const [videoMode, setVideoMode] = useState<DraftMode>('video.text');
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [models, setModels] = useState<ConnectionModels | null>(null);
  const [onboarding, setOnboarding] = useState<'connection' | 'defaults' | null>(null);
  const online = useSyncExternalStore(useCallback(listener => { window.addEventListener('online',listener); window.addEventListener('offline',listener); return () => {window.removeEventListener('online',listener);window.removeEventListener('offline',listener);}; },[]),()=>navigator.onLine,()=>true);
  const [notice, setNotice] = useState('');
  const [onboardingRevision, setOnboardingRevision] = useState(0);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getLocalHistory>> | null>(null);
  const [historyError, setHistoryError] = useState('');
  const workspace = useRef<Setting<WorkspacePreferences> | null>(null);
  const wizard = useRef<Setting<OnboardingPreferences> | null>(null);
  const settingsQueue = useRef(Promise.resolve());
  const returnPage = useRef<WorkbenchPage>('image');
  const booting = useRef(false);
  const currentConnectionVersion = useRef<string | null>(null);
  const acceptModels = useCallback((value: ConnectionModels) => { if(value.connectionVersionId === currentConnectionVersion.current) setModels(value); }, []);
  const load = useCallback(async () => {
    if (booting.current) return; booting.current = true; setBootError('');
    try {
      const [saved, preferences, progress] = await Promise.all([getCurrentConnection(), getSetting<WorkspacePreferences>('workspace'), getSetting<OnboardingPreferences>('onboarding'), loadDrafts()]);
      workspace.current = preferences; wizard.current = progress; setOnboardingRevision(progress.revision); currentConnectionVersion.current = saved?.connectionVersionId || null; setConnection(saved);
      if (saved) acceptModels(await getConnectionModels(saved.connectionId)); else setModels(null);
      const restored = preferences.value?.activeMode;
      const activeMode = restored && DRAFT_MODES.includes(restored) ? restored : 'image.text';
      returnPage.current = preferences.value?.returnPage || (activeMode === 'image.text' ? 'image' : 'video');
      setMode(activeMode); if (activeMode !== 'image.text') setVideoMode(activeMode);
      const restoredPage = preferences.value?.activePage;
      setPage(restoredPage && WORKBENCH_PAGES.includes(restoredPage) ? restoredPage : activeMode === 'image.text' ? 'image' : 'video');
      setOnboarding(progress.value?.dismissed ? null : progress.value?.step === 'defaults' && saved ? 'defaults' : !saved || progress.value?.step === 'connection' ? 'connection' : null);
      setReady(true);
    } catch (e) { setBootError(localErrorMessage(e)); }
    finally { booting.current = false; }
  }, [loadDrafts, acceptModels]);
  useEffect(() => {
    document.getElementById('app-boot-loader')?.remove(); document.documentElement.setAttribute('data-theme', 'dark');
    void Promise.resolve().then(load);
  }, [load]);
  const refreshHistory = useCallback(async () => { try { const result = await getLocalHistory(); setHistory(result); setHistoryError(''); } catch (e) { setHistoryError(localErrorMessage(e)); } }, []);
  useEffect(() => { if (ready) void Promise.resolve().then(refreshHistory); }, [page, ready, refreshHistory]);
  function remember(patch: WorkspacePreferences) {
    settingsQueue.current = settingsQueue.current.catch(() => {}).then(async () => {
      const previous = workspace.current!;
      workspace.current = await putSetting('workspace', { ...previous.value, ...patch }, previous.revision);
    }).catch(e => { setNotice(localErrorMessage(e)); });
  }
  async function progress(value: OnboardingPreferences) {
    const previous = wizard.current!;
    wizard.current = await putSetting('onboarding', value, previous.revision); setOnboardingRevision(wizard.current.revision);
  }
  function navigate(target: WorkbenchPage) {
    window.scrollTo(0, 0);
    if (target === 'settings' && page !== 'settings') returnPage.current = page;
    setNotice(''); setPage(target);
    if (target === 'image') { setMode('image.text'); remember({ activePage: target, activeMode: 'image.text' }); }
    else if (target === 'video') { setMode(videoMode); remember({ activePage: target, activeMode: videoMode }); }
    else remember({ activePage: target, ...(target === 'settings' ? {returnPage: returnPage.current as 'image' | 'video' | 'library'} : {}) });
  }
  function changeMode(next: DraftMode) { setMode(next); setVideoMode(next); remember({ activeMode: next, activePage: 'video' }); }
  function saveConnectionSummary(saved: ConnectionSummary) {
    currentConnectionVersion.current = saved.connectionVersionId; setConnection(saved); setModels(null);
    void getConnectionModels(saved.connectionId).then(acceptModels).catch(e => setNotice(localErrorMessage(e)));
  }
  async function finish(image: string, video: string) {
    if (!connection) return;
    const result = await window.novaDesktop?.completeWorkbenchSetup({ connectionId: connection.connectionId, expectedVersionId: connection.connectionVersionId, defaultImageModel: image, defaultVideoModel: video, ...(onboarding ? { expectedOnboardingRevision: wizard.current!.revision } : {}) });
    if (!result?.ok || !result.connection) throw Error(result?.code);
    currentConnectionVersion.current = result.connection.connectionVersionId; setConnection(result.connection); acceptModels(await getConnectionModels(result.connection.connectionId));
    if (result.onboarding) { wizard.current = result.onboarding; setOnboardingRevision(result.onboarding.revision); }
    if (onboarding) { setOnboarding(null); navigate('image'); } else setNotice('默认项已保存。已有草稿和任务未被修改。');
  }
  const connectionDescription = connectionMessage(connection, online);
  if (!ready) return <div className="nova-workbench wb-loading" aria-busy={!bootError}>{bootError ? <><h1>暂时无法读取本机工作台</h1><p role="alert">{bootError}</p><button type="button" onClick={() => void load()}>重新读取</button></> : <><Sparkles className="wb-loading-icon" /><p>正在读取本机草稿与设置…</p></>}</div>;
  if (onboarding) return <div className="nova-workbench wb-onboarding"><header className="wb-brand"><span><Sparkles size={21} /></span>影像工作台</header><div className="wb-welcome"><h1>欢迎使用<span>影像工作台</span></h1><p>连接你的生成服务，开始创作图片和视频</p><small>作品保存在本机。生成时会将提示词和所选图片发送到配置的服务。</small></div><div className="wb-onboarding-card"><ol className="wb-steps"><li aria-current={onboarding === 'connection' ? 'step' : undefined}><b>1</b>连接服务</li><li aria-current={onboarding === 'defaults' ? 'step' : undefined}><b>2</b>设置默认项</li></ol>{onboarding === 'connection' ? <ConnectionForm key="onboarding-connection" connection={connection} onboarding onboardingRevision={onboardingRevision} onSaved={saveConnectionSummary} onModels={acceptModels} onContinue={async () => { wizard.current = await getSetting<OnboardingPreferences>('onboarding'); setOnboardingRevision(wizard.current.revision); setOnboarding('defaults'); }} onSaveLater={async () => { await progress({ dismissed: true, step: 'completed' }); setOnboarding(null); }} onSkip={async () => { await progress({ dismissed: true, step: 'completed' }); setOnboarding(null); }} /> : connection && <><DefaultSettings key={connection.connectionVersionId} connection={connection} models={models} onboarding onComplete={finish} onBack={() => { void progress({ dismissed: false, step: 'connection' }).then(() => setOnboarding('connection')).catch(e => setNotice(localErrorMessage(e))); }} /><button type="button" className="wb-link" onClick={() => { void progress({ dismissed: true, step: 'completed' }).then(() => setOnboarding(null)).catch(e => setNotice(localErrorMessage(e))); }}>稍后设置，进入工作台</button></>}{notice && <p role="alert" className="wb-error">{notice}</p>}</div><footer className="wb-onboarding-footer">{connectionDescription}</footer></div>;
  const activeDraft = drafts.drafts[mode]!;
  const relevant = history?.items.filter(task => page === 'image' ? task.mode.startsWith('image') || task.mode.includes('to-image') : task.mode.startsWith('video') || task.mode === 'plugin') || [];
  return <div className="nova-workbench wb-shell"><aside className="wb-sidebar"><a className="wb-brand" href="#" onClick={event => { event.preventDefault(); navigate('image'); }}><span><Sparkles size={21} /></span><div>影像工作台<small>NOVA STUDIO</small></div></a><nav aria-label="主要导航">{WORKBENCH_PAGES.filter(target => PRODUCT_FEATURES[target]).map(target => { const Icon = PAGE_ICONS[target]; return <button key={target} type="button" aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)}><Icon size={19} /><span>{PAGE_LABELS[target]}</span></button>; })}</nav><div className="wb-sidebar-bottom"><span className="wb-local-indicator" />作品保存在本机<small>{connection ? connection.displayName : '尚未配置生成服务'}</small></div></aside><div className="wb-main"><header className="wb-page-header"><div><p>你的灵感，在这里成形</p><h1>{PAGE_LABELS[page]}</h1></div><span className="wb-local-pill">本地工作空间</span></header><div className="wb-connection-banner"><div><p>{connectionDescription}</p>{connection?.lastCheckedAt && <small>最近检查：{new Date(connection.lastCheckedAt).toLocaleString('zh-CN')}{connection.lastSuccessAt && connection.validationState !== 'verified' && ` · 上次成功：${new Date(connection.lastSuccessAt).toLocaleString('zh-CN')}`}</small>}</div>{page !== 'settings' && <button type="button" onClick={() => navigate('settings')}>配置连接</button>}</div>{notice && <p role="status" className="wb-notice">{notice}</p>}
    {page === 'settings' ? <div className="wb-settings"><div className="wb-section-heading"><h2>生成服务</h2><button type="button" className="wb-link" onClick={() => navigate(returnPage.current === 'settings' ? 'image' : returnPage.current)}><ArrowLeft size={16} />返回创作</button></div><section className="wb-panel"><ConnectionForm key={connection?.connectionVersionId || 'new'} connection={connection} onSaved={saveConnectionSummary} onModels={acceptModels} /></section>{connection && <section className="wb-panel"><DefaultSettings connection={connection} models={models} onComplete={finish} /></section>}</div> : page === 'library' ? <section className="wb-panel wb-library"><div className="wb-section-heading"><h2>本机作品与任务</h2><button type="button" onClick={() => void refreshHistory()}>刷新</button></div><p className="wb-help">当前展示最近的真实本地记录。{history && `共 ${history.total} 条。`}</p>{historyError ? <p role="alert" className="wb-error">{historyError}</p> : !history ? <div className="wb-empty">正在读取本机记录…</div> : history.total === 0 ? <div className="wb-empty"><FolderHeart size={40} /><h3>作品库还是空的</h3><p>生成并保存的作品会出现在这里。</p><button type="button" onClick={() => navigate('image')}>准备图片草稿</button></div> : <div className="wb-library-grid">{history.items.map(task => <article key={task.localTaskId}>{task.outputAssets?.[0]?.availability === 'available' && task.outputAssets[0].kind === 'image' ? <img src={task.outputAssets[0].previewUrl} alt={task.prompt || '本地图片作品'} /> : <div className="wb-library-placeholder"><Film size={28} /></div>}<strong>{STATE_LABELS[task.status] || task.status}</strong><p>{task.prompt || '未填写提示词'}</p><small>{task.model}</small></article>)}</div>}</section> : <><div className="wb-mode-row">{page === 'video' ? <div role="tablist" aria-label="视频模式">{VIDEO_MODES.map(item => <button type="button" key={item.mode} role="tab" aria-selected={mode === item.mode} onClick={() => changeMode(item.mode)}>{item.title}</button>)}</div> : <p>从文字和参考图片开始创作</p>}<span>独立草稿 · 自动保存</span></div><div className="wb-workspace-grid"><DraftEditor key={mode} draft={activeDraft} connection={connection} models={models} saving={Boolean(drafts.saving[mode])} error={drafts.errors[mode]} onChange={patch => drafts.update(mode, patch, mode === 'image.text' ? connection?.defaultImageModel || 'gpt-image-2.5-flare' : connection?.defaultVideoModel || 'grok-imagine-video-1.5-6s')} onConfigure={() => navigate('settings')} onRetry={() => void drafts.retry(mode)} onReload={() => { void drafts.reload(mode).catch(e => setNotice(localErrorMessage(e))); }} /><section className="wb-panel wb-preview"><div className="wb-section-heading"><h2>{page === 'image' ? '图片预览' : '视频预览'}</h2><span className="wb-help">等待创作</span></div><div className="wb-empty">{page === 'image' ? <ImageIcon size={44} /> : <Film size={44} />}<h3>生成结果将在这里显示</h3><p>{mode === 'video.dual_reference' ? '添加两张参考图，描述它们之间的剧情。' : '写下灵感，准备你的第一份创作草稿。'}</p></div><div className="wb-preview-actions"><button type="button" disabled>另存副本</button><button type="button" disabled>打开结果目录</button></div></section></div><section className="wb-panel wb-recents"><div className="wb-section-heading"><h2>最近任务</h2><button type="button" className="wb-link" onClick={() => navigate('library')}>查看作品库</button></div>{historyError ? <p role="alert" className="wb-error">{historyError}</p> : !history ? <p>正在读取本机任务…</p> : !relevant.length ? <p className="wb-help">还没有生成任务</p> : <div className="wb-recent-list">{relevant.slice(0, 4).map(task => <article key={task.localTaskId}><span>{STATE_LABELS[task.status] || task.status}</span><p>{task.prompt || '未填写提示词'}</p><small>{task.model}</small>{['submission_unknown', 'polling_paused'].includes(task.status) && <p className="wb-warning">远端可能仍在生成或计费，后续排队将等待明确终态。停止查询不代表取消或退款。</p>}</article>)}</div>}</section></>}
  </div></div>;
}
