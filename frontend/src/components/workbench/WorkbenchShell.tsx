'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Film, FolderHeart, Image as ImageIcon, Settings, Sparkles } from 'lucide-react';
import { ConnectionForm } from './ConnectionForm';
import { DefaultSettings } from './DefaultSettings';
import { DraftEditor, VIDEO_MODES } from './DraftEditor';
import { WorkbenchLibrary } from './WorkbenchLibrary';
import { TaskBadge, TaskDetails, TaskPreview, TaskThumbnail, WorkbenchDialog } from './WorkbenchResults';
import { useWorkbenchDrafts } from '@/hooks/useWorkbenchDrafts';
import { useWorkbenchTasks } from '@/hooks/useWorkbenchTasks';
import { reusableDraft, elapsed } from '@/lib/workbench-generation';
import type { AssetSummary } from '@/lib/workbench-task-client';
import { ConnectionModels, ConnectionSummary, getConnectionModels, getCurrentConnection } from '@/lib/connection-client';
import { connectionMessage, DRAFT_MODES, Draft, DraftMode, getHistoryTask, getSetting, HistoryTask, localErrorMessage, localRead, OnboardingPreferences, putSetting, PRODUCT_FEATURES, Setting, SubmissionIntent, WorkbenchPage, WORKBENCH_PAGES, WorkspacePreferences } from '@/lib/workbench-client';
const PAGE_LABELS: Record<WorkbenchPage, string> = { image: '图片生成', video: '视频生成', library: '作品库', settings: '设置' };
const PAGE_ICONS = { image: ImageIcon, video: Film, library: FolderHeart, settings: Settings };
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
  const tasks = useWorkbenchTasks(ready && !onboarding, page === 'image' ? 'image' : 'video', connection, models);
  const [details,setDetails] = useState<HistoryTask | null>(null), [libraryRevision,setLibraryRevision] = useState(0), [picking,setPicking] = useState(false);
  const [transfer,setTransfer] = useState<{mode:DraftMode;patch:Partial<Draft>;description:string} | null>(null);
  const [discardingIntent,setDiscardingIntent] = useState<SubmissionIntent | null>(null);
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
  async function transferToVideo(assets: AssetSummary[]) {
    try {
      const checked = await Promise.all(assets.map(async asset => (await localRead<{asset:AssetSummary}>('/api/nova/assets/'+asset.assetId)).asset));
      if (![1,2].includes(checked.length) || checked.some(asset => asset.availability !== 'available' || !['image/png','image/jpeg'].includes(asset.mimeType))) throw Error('ASSET_MISSING');
      const destination = checked.length === 2 ? 'video.dual_reference' : 'video.single_reference';
      setTransfer({mode:destination,patch:{inputAssets:checked},description:`按所选顺序将 ${checked.length} 张图片带入${checked.length === 2 ? '双图参考' : '单图视频'}草稿。`});
    } catch (error) { setNotice(localErrorMessage(error)); }
  }
  async function reuse(task: HistoryTask) {
    try { const fresh = await getHistoryTask(task.localTaskId); const destination = fresh.mode.startsWith('image') || fresh.mode.includes('to-image') ? 'image.text' : DRAFT_MODES.includes(fresh.mode as DraftMode) ? fresh.mode as DraftMode : null; if (!destination) {setNotice('此旧记录的模式无法直接复用，请复制提示词后选择当前模式。');return;} setTransfer({mode:destination,patch:reusableDraft(fresh),description:'将任务的原始型号、提示词、参数和有序参考图复制到草稿。缺失参考图会保留提示，提交前重新核对能力。'}); } catch (error) {setNotice(localErrorMessage(error));}
  }
  function applyTransfer() { if (!transfer) return; const {mode:target,patch}=transfer; drafts.update(target,patch,target === 'image.text' ? connection?.defaultImageModel : connection?.defaultVideoModel); setDetails(null); setTransfer(null); setPicking(false); if (target === 'image.text') navigate('image'); else {setVideoMode(target);setMode(target);setPage('video');remember({activePage:'video',activeMode:target});} setNotice('已创建可编辑草稿，请核对后明确点击生成。未自动提交。'); }
  if (!ready) return <div className="nova-workbench wb-loading" aria-busy={!bootError}>{bootError ? <><h1>暂时无法读取本机工作台</h1><p role="alert">{bootError}</p><button type="button" onClick={() => void load()}>重新读取</button></> : <><Sparkles className="wb-loading-icon" /><p>正在读取本机草稿与设置…</p></>}</div>;
  if (onboarding) return <div className="nova-workbench wb-onboarding"><header className="wb-brand"><span><Sparkles size={21} /></span>影像工作台</header><div className="wb-welcome"><h1>欢迎使用<span>影像工作台</span></h1><p>连接你的生成服务，开始创作图片和视频</p><small>作品保存在本机。生成时会将提示词和所选图片发送到配置的服务。</small></div><div className="wb-onboarding-card"><ol className="wb-steps"><li aria-current={onboarding === 'connection' ? 'step' : undefined}><b>1</b>连接服务</li><li aria-current={onboarding === 'defaults' ? 'step' : undefined}><b>2</b>设置默认项</li></ol>{onboarding === 'connection' ? <ConnectionForm key="onboarding-connection" connection={connection} onboarding onboardingRevision={onboardingRevision} onSaved={saveConnectionSummary} onModels={acceptModels} onContinue={async () => { wizard.current = await getSetting<OnboardingPreferences>('onboarding'); setOnboardingRevision(wizard.current.revision); setOnboarding('defaults'); }} onSaveLater={async () => { await progress({ dismissed: true, step: 'completed' }); setOnboarding(null); }} onSkip={async () => { await progress({ dismissed: true, step: 'completed' }); setOnboarding(null); }} /> : connection && <><DefaultSettings key={connection.connectionVersionId} connection={connection} models={models} onboarding onComplete={finish} onBack={() => { void progress({ dismissed: false, step: 'connection' }).then(() => setOnboarding('connection')).catch(e => setNotice(localErrorMessage(e))); }} /><button type="button" className="wb-link" onClick={() => { void progress({ dismissed: true, step: 'completed' }).then(() => setOnboarding(null)).catch(e => setNotice(localErrorMessage(e))); }}>稍后设置，进入工作台</button></>}{notice && <p role="alert" className="wb-error">{notice}</p>}</div><footer className="wb-onboarding-footer">{connectionDescription}</footer></div>;
  const activeDraft = drafts.drafts[mode]!;
  const alreadySubmitted = tasks.alreadySubmitted(activeDraft);
  return <div className="nova-workbench wb-shell"><aside className="wb-sidebar"><a className="wb-brand" href="#" onClick={event => { event.preventDefault(); navigate('image'); }}><span><Sparkles size={21} /></span><div>影像工作台<small>NOVA STUDIO</small></div></a><nav aria-label="主要导航">{WORKBENCH_PAGES.filter(target => PRODUCT_FEATURES[target]).map(target => { const Icon = PAGE_ICONS[target]; return <button key={target} type="button" aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)}><Icon size={19} /><span>{PAGE_LABELS[target]}</span></button>; })}</nav><div className="wb-sidebar-bottom"><span className="wb-local-indicator" />作品保存在本机<small>{connection ? connection.displayName : '尚未配置生成服务'}</small></div></aside><div className="wb-main"><header className="wb-page-header"><div><p>你的灵感，在这里成形</p><h1>{PAGE_LABELS[page]}</h1></div><span className="wb-local-pill">本地工作空间</span></header><div className="wb-connection-banner"><div><p>{connectionDescription}</p>{connection?.lastCheckedAt && <small>最近检查：{new Date(connection.lastCheckedAt).toLocaleString('zh-CN')}{connection.lastSuccessAt && connection.validationState !== 'verified' && ` · 上次成功：${new Date(connection.lastSuccessAt).toLocaleString('zh-CN')}`}</small>}</div>{page !== 'settings' && <button type="button" onClick={() => navigate('settings')}>配置连接</button>}</div>{notice && <p role="status" className="wb-notice">{notice}</p>}{tasks.notice && <p role="status" className="wb-notice">{tasks.notice}</p>}
    {tasks.reconciliationError && <p role="alert" className="wb-error">{tasks.reconciliationError}<button type="button" onClick={() => void tasks.reconcile()}>重新核对提交记录</button></p>}
    {tasks.intents.length > 0 && <div className="wb-notice"><h2>本地提交意图待核对</h2><p>回执不明时不会重发创建请求，重启也不会自动提交。先核对本地任务和供应商记录。</p>{tasks.intents.map(intent => <div key={intent.localRequestId}><p>{intent.attemptStartedAt ? '已进入发送步骤，本地回执尚未确认' : '仅保存了本地意图，尚未进入发送步骤'} · {intent.input.model} · {intent.localRequestId}</p><button type="button" onClick={() => { void tasks.reconcile().then(tasks.refresh); }}>核对本地任务</button><button type="button" onClick={() => setDiscardingIntent(intent)}>结束此意图的本地核对</button></div>)}</div>}
    {page === 'settings' ? <div className="wb-settings"><div className="wb-section-heading"><h2>生成服务</h2><button type="button" className="wb-link" onClick={() => navigate(returnPage.current === 'settings' ? 'image' : returnPage.current)}><ArrowLeft size={16} />返回创作</button></div><section className="wb-panel"><ConnectionForm key={connection?.connectionVersionId || 'new'} connection={connection} onSaved={saveConnectionSummary} onModels={acceptModels} /></section>{connection && <section className="wb-panel"><DefaultSettings connection={connection} models={models} onComplete={finish} /></section>}</div>
    : page === 'library' ? <WorkbenchLibrary key={picking ? 'picking' : 'browse'} revision={libraryRevision} picking={picking} onDetails={setDetails} onVideo={assets => void transferToVideo(assets)} onImage={() => navigate('image')} />
    : <><div className="wb-mode-row">{page === 'video' ? <div role="tablist" aria-label="视频模式">{VIDEO_MODES.map(item => <button type="button" key={item.mode} role="tab" aria-selected={mode === item.mode} onClick={() => changeMode(item.mode)}>{item.title}</button>)}</div> : <p>从文字和参考图片开始创作</p>}<span>独立草稿 · 自动保存</span></div><div className="wb-workspace-grid"><div><DraftEditor key={mode} draft={activeDraft} connection={connection} models={models} saving={Boolean(drafts.saving[mode])} error={drafts.errors[mode]} onChange={patch => drafts.update(mode, patch, mode === 'image.text' ? connection?.defaultImageModel || 'gpt-image-2.5-flare' : connection?.defaultVideoModel || 'grok-imagine-video-1.5-6s')} onConfigure={() => navigate('settings')} onRetry={() => void drafts.retry(mode)} onReload={() => { void drafts.reload(mode).catch(error => setNotice(localErrorMessage(error))); }} onSubmit={() => void tasks.submit(activeDraft)} submitting={tasks.submitting} submitDisabled={!tasks.reconciliationReady || alreadySubmitted || tasks.intents.length > 0} onChooseLibrary={() => {setPicking(true);navigate('library');}} />{alreadySubmitted && <div className="wb-notice"><p>此草稿已提交。再次创建会产生新的生成任务，可能再次计费。</p><button type="button" onClick={() => tasks.allowAnother(activeDraft)}>准备以相同草稿新建任务</button></div>}</div><TaskPreview key={tasks.selected?.localTaskId || page} task={tasks.selected} image={page === 'image'} now={tasks.now} onDetails={setDetails} onVideo={assets => void transferToVideo(assets)} /></div><section className="wb-panel wb-recents"><div className="wb-section-heading"><h2>{page === 'image' ? '最近图片结果与任务' : '最近视频任务'}</h2><button type="button" className="wb-link" onClick={() => navigate('library')}>查看作品库</button></div>{tasks.error ? <p role="alert" className="wb-error">{tasks.error}</p> : !tasks.history ? <p>正在读取本机任务…</p> : !tasks.history.items.length ? <p className="wb-help">还没有生成任务</p> : <div className="wb-recent-list">{tasks.history.items.slice(0,6).map(task => <article key={task.localTaskId}><button type="button" className="wb-card-open" onClick={() => tasks.select(task)} aria-label={`预览任务：${task.prompt || task.localTaskId}`}><TaskThumbnail task={task} /><TaskBadge task={task} /><p>{task.prompt || '未填写提示词'}</p><small>{task.model} · 已用 {elapsed(task,tasks.now)}</small></button><button type="button" className="wb-link" onClick={() => setDetails(task)}>任务详情</button>{task.remoteMayContinue && <p className="wb-warning">远端可能仍在生成或计费，后续排队等待明确终态。停止查询不代表取消或退款。</p>}{task.requiresContinue && <p className="wb-warning">重启后等待明确继续，尚未自动提交。</p>}</article>)}</div>}</section></>}
    {details && <TaskDetails key={details.localTaskId} task={details} now={tasks.now} onClose={() => setDetails(null)} onReuse={task => void reuse(task)} onVideo={assets => void transferToVideo(assets)} onChanged={() => {setLibraryRevision(value => value+1);void tasks.refresh();}} />}
    {discardingIntent && <WorkbenchDialog title="结束本地意图核对" onClose={() => setDiscardingIntent(null)}><p>这只关闭此意图的本地核对提醒。已存在任务及其生成占位仍保留，远端可能继续生成或计费。重新新建相同内容可能产生重复费用。</p><div className="wb-actions"><button type="button" onClick={() => setDiscardingIntent(null)}>继续保留核对</button><button type="button" onClick={() => { void tasks.discard(discardingIntent).then(() => setDiscardingIntent(null)).catch(error => setNotice(localErrorMessage(error))); }}>确认结束本地核对</button></div></WorkbenchDialog>}
    {transfer && <WorkbenchDialog title="将内容带入草稿" onClose={() => setTransfer(null)}><p>{transfer.description}</p><p className="wb-warning">这会替换目标模式草稿中对应内容；原作品与任务记录保留。仅编辑草稿，不会自动生成。</p><div className="wb-actions"><button type="button" onClick={() => setTransfer(null)}>保留原草稿</button><button type="button" onClick={applyTransfer}>确认带入草稿</button></div></WorkbenchDialog>}
  </div></div>;
}
