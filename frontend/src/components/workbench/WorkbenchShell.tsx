'use client';
import { DiagnosticsExport } from './DiagnosticsExport';
import { AppUpdate, UpdateNotice, SidebarVersion } from './AppUpdate';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { isUpdateFrozen } from '@/lib/update-readiness';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Film, FolderHeart, Image as ImageIcon, Settings, Sparkles } from 'lucide-react';
import { ConnectionForm } from './ConnectionForm';
import { DefaultSettings } from './DefaultSettings';
import { TaskExecutionSettings } from './TaskExecutionSettings';
import { RecentVideoTaskSettings } from './RecentVideoTaskSettings';
import { MAX_VIDEO_REFERENCE_ASSETS } from '@/lib/reference-policy';
import { DraftEditor, VIDEO_MODES, type SubmitBlocker } from './DraftEditor';
import { WorkbenchAllTasks } from './WorkbenchAllTasks';
import { MediaTaskCard } from './MediaTaskCard';
import { GroupRecoveryBanner } from './GroupRecoveryBanner';
import { GroupMoveDialog } from './GroupMoveDialog';
import { GroupManager, GroupPicker } from './WorkbenchGroups';
import { useWorkbenchGroups } from '@/hooks/useWorkbenchGroups';
import { WorkbenchLibrary } from './WorkbenchLibrary';
import { TaskDetails, TaskPreview, WorkbenchDialog } from './WorkbenchResults';
import { useWorkbenchDrafts } from '@/hooks/useWorkbenchDrafts';
import { useWorkbenchTasks } from '@/hooks/useWorkbenchTasks';
import { useRejectedModelRefresh } from '@/hooks/useRejectedModelRefresh';
import { reusableDraft, taskExecutionActive } from '@/lib/workbench-generation';
import type { AssetSummary } from '@/lib/workbench-task-client';
import { ConnectionModels, ConnectionSummary, checkConnection, getConnectionModels, getCurrentConnection, sameConnectionTransport } from '@/lib/connection-client';
import { connectionBanner, DEFAULT_GROUP_ID, DRAFT_MODES, Draft, DraftMode, getHistoryTask, getRecentVideoTaskLimit, getSetting, HistoryTask, localErrorMessage, localRead, OnboardingPreferences, putSetting, PRODUCT_FEATURES, Setting, SubmissionIntent, WorkbenchPage, WORKBENCH_PAGES, WorkspacePreferences } from '@/lib/workbench-client';
const PAGE_LABELS: Record<WorkbenchPage, string> = { image: '图片生成', video: '视频生成', library: '作品库', settings: '设置' };
const PAGE_ICONS = { image: ImageIcon, video: Film, library: FolderHeart, settings: Settings };
export function WorkbenchShell() {
  const drafts = useWorkbenchDrafts();
  const loadDrafts = drafts.load, switchDraftGroup = drafts.switchGroup;
  const groupState = useWorkbenchGroups();
  const [allTasks, setAllTasks] = useState(false), [regrouping,setRegrouping] = useState<HistoryTask | null>(null);
  const [managingGroups, setManagingGroups] = useState(false), [modeSwitching, setModeSwitching] = useState(false);
  const modeLock = useRef(false), importsInFlight = useRef(new Set<string>());
  const [draftImportBusy,setDraftImportBusy] = useState(false);
  const [ready, setReady] = useState(false), [bootError, setBootError] = useState('');
  const [page, setPage] = useState<WorkbenchPage>('image');
  const [locateUpdate, setLocateUpdate] = useState(false);
  const updatePanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (page !== 'settings' || !locateUpdate) return;
    updatePanel.current?.scrollIntoView?.({ block: 'start' });
    updatePanel.current?.focus({ preventScroll: true });
    setLocateUpdate(false);
  }, [page, locateUpdate]);
  const [mode, setMode] = useState<DraftMode>('image.text');
  const [videoMode, setVideoMode] = useState<DraftMode>('video.text');
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [models, setModels] = useState<ConnectionModels | null>(null);
  const currentModelConnection = useRef<ConnectionSummary | null>(null);
  const acceptModels = useCallback((value: ConnectionModels) => { if(currentModelConnection.current && sameConnectionTransport(currentModelConnection.current, value)) setModels(value); }, []);
  const [onboarding, setOnboarding] = useState<'connection' | 'defaults' | null>(null);
  const online = useSyncExternalStore(useCallback(listener => { window.addEventListener('online',listener); window.addEventListener('offline',listener); return () => {window.removeEventListener('online',listener);window.removeEventListener('offline',listener);}; },[]),()=>navigator.onLine,()=>true);
  const [notice, setNotice] = useState('');
  const [onboardingRevision, setOnboardingRevision] = useState(0);
  const [recentVideoTaskLimit, setRecentVideoTaskLimit] = useState(6);
  const tasks = useWorkbenchTasks(ready && !onboarding, page === 'image' ? 'image' : 'video', connection, models, acceptModels, recentVideoTaskLimit, drafts.groupId);
  const [details,setDetails] = useState<HistoryTask | null>(null), [libraryRevision,setLibraryRevision] = useState(0), [picking,setPicking] = useState(false);
  const [transfer,setTransfer] = useState<{mode:DraftMode;patch:Partial<Draft>;description:string} | null>(null);
  const [discardingIntent,setDiscardingIntent] = useState<SubmissionIntent | null>(null);
  const workspace = useRef<Setting<WorkspacePreferences> | null>(null);
  const wizard = useRef<Setting<OnboardingPreferences> | null>(null);
  const settingsQueue = useRef(Promise.resolve());
  const settingsSaveFailed = useRef(false);
  const updates = useAppUpdate(async () => { await drafts.flush(); await settingsQueue.current; if (settingsSaveFailed.current) throw Error('UPDATE_SAVE_FAILED'); }, ready);
  const returnPage = useRef<WorkbenchPage>('image');
  const booting = useRef(false);
  useRejectedModelRefresh(connection, tasks.history?.items, acceptModels);
  const groupCountsKey = tasks.history?.items.map(task => [task.localTaskId,task.revision,task.status,task.outputAssets?.length].join(':')).join(',');
  useEffect(() => { if (groupCountsKey) void groupState.refresh(); }, [groupCountsKey, groupState.refresh]);
  const load = useCallback(async () => {
    if (booting.current) return; booting.current = true; setBootError('');
    try {
      const [saved, preferences, progress] = await Promise.all([getCurrentConnection(), getSetting<WorkspacePreferences>('workspace'), getSetting<OnboardingPreferences>('onboarding'), loadDrafts()]);
      let effectivePreferences = preferences;
      if (preferences.value?.activeGroupId) {
        try { await switchDraftGroup(preferences.value.activeGroupId); }
        catch (error) {
          if (!(error instanceof Error) || !['GROUP_NOT_FOUND','GROUP_DELETED'].includes(error.message)) throw error;
          effectivePreferences = await putSetting('workspace', { ...preferences.value, activeGroupId: DEFAULT_GROUP_ID }, preferences.revision);
          setNotice('原剧本分组已不存在，已恢复未分组；其他草稿与任务保留。');
        }
      }
      workspace.current = effectivePreferences; setRecentVideoTaskLimit(getRecentVideoTaskLimit(preferences.value?.recentVideoTaskLimit)); wizard.current = progress; setOnboardingRevision(progress.revision); currentModelConnection.current = saved; setConnection(saved);
      if (saved) {acceptModels(await getConnectionModels(saved.connectionId));if(saved.hasCredential)void checkConnection(saved,true,'startup').then(value=>{if(!value.stale&&value.models)acceptModels(value as ConnectionModels);}).catch(()=>{});} else setModels(null);
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
  }, [loadDrafts, switchDraftGroup, acceptModels]);
  useEffect(() => {
    document.getElementById('app-boot-loader')?.remove(); document.documentElement.setAttribute('data-theme', 'dark');
    void Promise.resolve().then(load);
  }, [load]);
  function queueWorkspace(operation: () => Promise<Setting<WorkspacePreferences>>) {
    const request = settingsQueue.current.catch(() => {}).then(async () => {
      const current = await operation();
      workspace.current = current; setRecentVideoTaskLimit(getRecentVideoTaskLimit(current.value?.recentVideoTaskLimit));
      settingsSaveFailed.current = false;
      return current;
    });
    settingsQueue.current = request.then(() => {}, e => { settingsSaveFailed.current = true; setNotice(localErrorMessage(e)); });
    return request;
  }
  function saveWorkspace(patch: WorkspacePreferences) {
    return queueWorkspace(() => { const previous = workspace.current!; return putSetting('workspace', { ...previous.value, ...patch }, previous.revision); });
  }
  function remember(patch: WorkspacePreferences) {
    if (isUpdateFrozen()) return;
    void saveWorkspace(patch).catch(() => {});
  }
  async function saveRecentVideoLimit(limit: number) {
    const saved = await saveWorkspace({ recentVideoTaskLimit: limit });
    if (saved.value?.recentVideoTaskLimit !== limit) throw Error('INVALID_SETTING_VALUE');
  }
  async function reloadRecentVideoLimit() {
    const saved = await queueWorkspace(() => getSetting<WorkspacePreferences>('workspace'));
    return getRecentVideoTaskLimit(saved.value?.recentVideoTaskLimit);
  }
  async function progress(value: OnboardingPreferences) {
    const previous = wizard.current!;
    wizard.current = await putSetting('onboarding', value, previous.revision); setOnboardingRevision(wizard.current.revision);
  }
  function navigate(target: WorkbenchPage) {
    if (isUpdateFrozen()) return;
    window.scrollTo(0, 0);
    if (target === 'settings' && page !== 'settings') returnPage.current = page;
    setNotice(''); setPage(target);
    if (target === 'image') { setMode('image.text'); remember({ activePage: target, activeMode: 'image.text' }); }
    else if (target === 'video') { setMode(videoMode); remember({ activePage: target, activeMode: videoMode }); }
    else remember({ activePage: target, ...(target === 'settings' ? {returnPage: returnPage.current as 'image' | 'video' | 'library'} : {}) });
  }
  function openUpdates() { if (isUpdateFrozen()) return; setLocateUpdate(true); navigate('settings'); }
  async function changeMode(next: DraftMode) { if (modeLock.current || importsInFlight.current.size || drafts.switching) return; modeLock.current = true; setModeSwitching(true); try { await drafts.flush(); setMode(next); setVideoMode(next); remember({ activeMode: next, activePage: 'video' }); } catch (error) { setNotice('草稿未能保存，已保留当前模式与输入。' + localErrorMessage(error)); } finally { modeLock.current = false; setModeSwitching(false); } }
  async function changeGroup(next: string) { if (modeLock.current || importsInFlight.current.size) return; try { if (await drafts.switchGroup(next)) remember({activeGroupId:next}); } catch (error) { setNotice('切换剧本失败，已保留当前剧本与草稿。' + localErrorMessage(error)); } }
  function saveConnectionSummary(saved: ConnectionSummary) {
    currentModelConnection.current = saved; setConnection(saved); setModels(null);
    void getConnectionModels(saved.connectionId).then(acceptModels).catch(e => setNotice(localErrorMessage(e)));
    if(saved.hasCredential)void checkConnection(saved,false,'connection_changed').then(value=>{if(!value.stale&&value.models)acceptModels(value as ConnectionModels);}).catch(()=>{});
  }
  async function finish(image: string, video: string) {
    if (!connection) return;
    const result = await window.novaDesktop?.completeWorkbenchSetup({ connectionId: connection.connectionId, expectedVersionId: connection.connectionVersionId, defaultImageModel: image, defaultVideoModel: video, ...(onboarding ? { expectedOnboardingRevision: wizard.current!.revision } : {}) });
    if (!result?.ok || !result.connection) throw Error(result?.code);
    currentModelConnection.current = result.connection; setConnection(result.connection); acceptModels(await getConnectionModels(result.connection.connectionId));
    if (result.onboarding) { wizard.current = result.onboarding; setOnboardingRevision(result.onboarding.revision); }
    void groupState.refresh();
    if (onboarding) { setOnboarding(null); navigate('image'); } else setNotice('默认项已保存。已有草稿和任务未被修改。');
  }
  async function beforeDeleteGroup(groupId: string) {
    if(modeLock.current || importsInFlight.current.size || drafts.switching)throw Error('DRAFT_SWITCH_BUSY');
    const selected = drafts.groupId === groupId;
    if(selected && !await drafts.switchGroup(DEFAULT_GROUP_ID))throw Error('DRAFT_SWITCH_BUSY');
    if(selected || workspace.current?.value?.activeGroupId === groupId)await saveWorkspace({activeGroupId:DEFAULT_GROUP_ID});
  }
  function groupChanged(){void groupState.refresh();void tasks.refresh();setLibraryRevision(value=>value+1);}
  const connectionDescription = connectionBanner(connection, online);
  async function transferToVideo(assets: AssetSummary[]) {
    try {
      const checked = await Promise.all(assets.map(async asset => (await localRead<{asset:AssetSummary}>('/api/nova/assets/'+asset.assetId)).asset));
      if (checked.length < 1 || checked.length > MAX_VIDEO_REFERENCE_ASSETS || checked.some(asset => asset.availability !== 'available' || !['image/png','image/jpeg'].includes(asset.mimeType))) throw Error('ASSET_MISSING');
      const destination = checked.length >= 2 ? 'video.dual_reference' : 'video.single_reference';
      setTransfer({mode:destination,patch:{inputAssets:checked},description:`按所选顺序将 ${checked.length} 张图片带入${checked.length >= 2 ? '多图参考' : '单图视频'}草稿。`});
    } catch (error) { setNotice(localErrorMessage(error)); }
  }
  async function transferToImage(asset: AssetSummary) {
    try {
      const checked = (await localRead<{asset:AssetSummary}>('/api/nova/assets/'+asset.assetId)).asset;
      if (checked.kind !== 'image' || checked.availability !== 'available' || !['image/png','image/jpeg'].includes(checked.mimeType)) throw Error('ASSET_MISSING');
      setTransfer({mode:'image.text',patch:{inputAssets:[checked]},description:'把此原始图片带入图片草稿作为编辑参考，请填写或核对修改描述。'});
    } catch (error) { setNotice(localErrorMessage(error)); }
  }
  async function reuse(task: HistoryTask) {
    try { const fresh = await getHistoryTask(task.localTaskId); const destination = fresh.mode.startsWith('image') || fresh.mode.includes('to-image') ? 'image.text' : fresh.mode === 'video.multi_reference' ? 'video.dual_reference' : DRAFT_MODES.includes(fresh.mode as DraftMode) ? fresh.mode as DraftMode : null; if (!destination) {setNotice('此旧记录的模式无法直接复用，请复制提示词后选择当前模式。');return;} setTransfer({mode:destination,patch:reusableDraft(fresh),description:'将任务的原始型号、提示词、参数和有序参考图复制到草稿。缺失参考图会保留提示，提交前重新核对能力。'}); } catch (error) {setNotice(localErrorMessage(error));}
  }
  function applyTransfer() { if (!transfer) return; const {mode:target,patch}=transfer; drafts.update(target,patch,target === 'image.text' ? connection?.defaultImageModel : connection?.defaultVideoModel); setDetails(null); setTransfer(null); setPicking(false); if (target === 'image.text') navigate('image'); else {setVideoMode(target);setMode(target);setPage('video');remember({activePage:'video',activeMode:target});} setNotice('已创建可编辑草稿，请核对后明确点击生成。未自动提交。'); }
  if (!ready) return <div className="nova-workbench wb-loading" aria-busy={!bootError}>{bootError ? <><h1>暂时无法读取本机工作台</h1><p role="alert">{bootError}</p><button type="button" onClick={() => void load()}>重新读取</button></> : <><Sparkles className="wb-loading-icon" /><p>正在读取本机草稿与设置…</p></>}</div>;
  if (onboarding) return <div className="nova-workbench wb-onboarding"><header className="wb-brand"><span><Sparkles size={21} /></span>影像工作台</header><div className="wb-welcome"><h1>欢迎使用<span>影像工作台</span></h1><p>连接你的生成服务，开始创作图片和视频</p><small>本地离线测试版 · 四种基础生成模式已实测，完整功能仍在验收。生成时会将提示词和所选图片发送到配置的服务。</small></div><div className="wb-onboarding-card"><ol className="wb-steps"><li aria-current={onboarding === 'connection' ? 'step' : undefined}><b>1</b>连接服务</li><li aria-current={onboarding === 'defaults' ? 'step' : undefined}><b>2</b>设置默认项</li></ol>{onboarding === 'connection' ? <ConnectionForm key="onboarding-connection" connection={connection} onboarding onboardingRevision={onboardingRevision} onSaved={saveConnectionSummary} onModels={acceptModels} onContinue={async () => { wizard.current = await getSetting<OnboardingPreferences>('onboarding'); setOnboardingRevision(wizard.current.revision); setOnboarding('defaults'); }} onSaveLater={async () => { await progress({ dismissed: true, step: 'completed' }); setOnboarding(null); }} onSkip={async () => { await progress({ dismissed: true, step: 'completed' }); setOnboarding(null); }} /> : connection && <><DefaultSettings key={connection.connectionVersionId} connection={connection} models={models} onModels={acceptModels} onboarding onComplete={finish} onBack={() => { void progress({ dismissed: false, step: 'connection' }).then(() => setOnboarding('connection')).catch(e => setNotice(localErrorMessage(e))); }} /><button type="button" className="wb-link" onClick={() => { void progress({ dismissed: true, step: 'completed' }).then(() => setOnboarding(null)).catch(e => setNotice(localErrorMessage(e))); }}>稍后设置，进入工作台</button></>}{notice && <p role="alert" className="wb-error">{notice}</p>}</div><footer className="wb-onboarding-footer">{connectionDescription}</footer></div>;
  const recentLimit = page === 'video' ? recentVideoTaskLimit : 6;
  const recentTasks = tasks.history?.items.slice(0,recentLimit) || [];
  const activeDraft = drafts.drafts[mode]!;
  const alreadySubmitted = tasks.alreadySubmitted(activeDraft);
  const submitBlockers: SubmitBlocker[] = [];
  const currentGroup = groupState.groups.find(group => group.groupId === drafts.groupId);
  if (currentGroup?.recoveryRequired) submitBlockers.push({code:'group-recovery',message:'当前剧本的文件整理需要恢复，请先点击重试恢复整理。'});
  if (currentGroup?.archived || (!currentGroup && drafts.groupId !== DEFAULT_GROUP_ID)) submitBlockers.push({code:'group-unavailable',message:currentGroup?.archived ? '当前剧本已归档，请选择可用剧本后生成。' : '当前剧本信息尚未读取，请重新读取分组或选择未分组。'});
  if (!tasks.reconciliationReady) submitBlockers.push({ code: 'reconciliation', message: '本地提交记录尚未核对完成，已暂停新建生成。', actionLabel: '核对提交记录', onAction: () => { void tasks.reconcile(); } });
  if (alreadySubmitted) submitBlockers.push({ code: 'already-submitted', message: '此草稿已提交。再次生成前，请先准备新任务。', actionLabel: '准备新任务', onAction: () => tasks.allowAnother(activeDraft) });
  if (tasks.intents.length > 0) submitBlockers.push({ code: 'unresolved-intent', message: '本地还有未解决的提交意图，请先核对，避免重复生成。', actionLabel: '核对本地任务', onAction: () => { void tasks.reconcile().then(tasks.refresh); } });
  if (updates.frozen) submitBlockers.push({ code: 'update-frozen', message: '应用正在准备更新或安装，暂不能新建生成。' });

  return <><div className="nova-workbench wb-shell" inert={updates.frozen}><aside className="wb-sidebar"><a className="wb-brand" href="#" onClick={event => { event.preventDefault(); navigate('image'); }}><span><Sparkles size={21} /></span><div>影像工作台<small>NOVA STUDIO</small></div></a><nav aria-label="主要导航">{WORKBENCH_PAGES.filter(target => PRODUCT_FEATURES[target]).map(target => { const Icon = PAGE_ICONS[target]; return <button key={target} type="button" aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)}><Icon size={19} /><span>{PAGE_LABELS[target]}</span></button>; })}</nav><div className="wb-sidebar-bottom"><div className="wb-sidebar-storage"><span className="wb-local-indicator" />作品保存在本机<small>{connection ? connection.displayName : '尚未配置生成服务'}</small></div><SidebarVersion state={updates.state} onOpen={openUpdates} /></div></aside><div className="wb-main"><header className="wb-page-header"><div><p>你的灵感，在这里成形</p><h1>{PAGE_LABELS[page]}</h1></div><span className="wb-local-pill">本地离线测试版</span></header><p className="wb-help" role="note">本地离线测试版 · 四种基础生成模式已实测，完整功能仍在验收</p>{connectionDescription && <div className="wb-connection-banner"><div><p>{connectionDescription}</p>{connection?.lastCheckedAt && <small>最近检查：{new Date(connection.lastCheckedAt).toLocaleString('zh-CN')}{connection.lastSuccessAt && connection.validationState !== 'verified' && ` · 上次成功：${new Date(connection.lastSuccessAt).toLocaleString('zh-CN')}`}</small>}</div>{page !== 'settings' && <button type="button" onClick={() => navigate('settings')}>配置连接</button>}</div>}<UpdateNotice state={updates.state} onOpen={openUpdates} />{notice && <p role="status" className="wb-notice">{notice}</p>}{tasks.notice && <p role="status" className="wb-notice">{tasks.notice}</p>}
    <GroupRecoveryBanner recovery={groupState.recovery} groups={groupState.groups} onChanged={groupChanged}/>{tasks.reconciliationError && <p role="alert" className="wb-error">{tasks.reconciliationError}<button type="button" onClick={() => void tasks.reconcile()}>重新核对提交记录</button></p>}
    {tasks.intents.length > 0 && <div className="wb-notice"><h2>本地提交意图待核对</h2><p>回执不明时不会重发创建请求，重启也不会自动提交。先核对本地任务和供应商记录。</p>{tasks.intents.map(intent => <div key={intent.localRequestId}><p>{intent.attemptStartedAt ? '已进入发送步骤，本地回执尚未确认' : '仅保存了本地意图，尚未进入发送步骤'} · {intent.input.model} · {intent.localRequestId}</p><button type="button" onClick={() => { void tasks.reconcile().then(tasks.refresh); }}>核对本地任务</button><button type="button" onClick={() => setDiscardingIntent(intent)}>结束此意图的本地核对</button></div>)}</div>}
    {page === 'settings' ? <div className="wb-settings"><div className="wb-section-heading"><h2>生成服务</h2><button type="button" className="wb-link" onClick={() => navigate(returnPage.current === 'settings' ? 'image' : returnPage.current)}><ArrowLeft size={16} />返回创作</button></div><section className="wb-panel"><ConnectionForm key={connection?.connectionId || 'new'} connection={connection} onSaved={saveConnectionSummary} onModels={acceptModels} /></section>{connection && <section className="wb-panel"><DefaultSettings connection={connection} models={models} onModels={acceptModels} onComplete={finish} /></section>}<RecentVideoTaskSettings value={recentVideoTaskLimit} onSave={saveRecentVideoLimit} onReload={reloadRecentVideoLimit} /><TaskExecutionSettings /><DiagnosticsExport /><div ref={updatePanel} tabIndex={-1} className="wb-update-anchor" aria-label="版本与应用更新"><AppUpdate state={updates.state} onInstall={updates.install} /></div></div>
    : page === 'library' ? <WorkbenchLibrary key={picking ? 'picking' : 'browse'} revision={libraryRevision} groups={groupState.groups} groupsReady={groupState.loaded} onManageGroups={() => setManagingGroups(true)} onRegroup={setRegrouping} onGroupsChanged={groupChanged} picking={picking} onDetails={setDetails} onVideo={assets => void transferToVideo(assets)} onImageReference={asset => void transferToImage(asset)} onImage={() => navigate('image')} />
    : <><div className="wb-mode-row">{page === 'video' ? <div role="tablist" aria-label="视频模式">{VIDEO_MODES.map(item => <button type="button" key={item.mode} role="tab" aria-selected={mode === item.mode} disabled={drafts.switching || modeSwitching} onClick={() => void changeMode(item.mode)}>{item.title}</button>)}</div> : <p>从文字和参考图片开始创作</p>}<span>独立草稿 · 自动保存</span></div><GroupPicker groups={groupState.groups} groupId={drafts.groupId} mediaKind={page === 'image' ? 'image' : 'video'} disabled={drafts.switching || modeSwitching || draftImportBusy} onChange={next => void changeGroup(next)} onManage={() => setManagingGroups(true)}/>{groupState.error && <p className="wb-error">{groupState.error}<button type="button" onClick={() => void groupState.refresh()}>重新读取分组</button></p>}<div className="wb-workspace-grid"><div><fieldset className="wb-draft-fieldset" disabled={drafts.switching || modeSwitching}><DraftEditor key={drafts.groupId+mode} draft={activeDraft} connection={connection} models={models} saving={Boolean(drafts.saving[mode])} error={drafts.errors[mode]} onChange={patch => drafts.update(mode, patch, mode === 'image.text' ? connection?.defaultImageModel || 'gpt-image-2.5-flare' : connection?.defaultVideoModel || 'grok-imagine-video-1.5-6s',drafts.groupId)} onConfigure={() => navigate('settings')} onRetry={() => void drafts.retry(mode)} onReload={() => { void drafts.reload(mode).catch(error => setNotice(localErrorMessage(error))); }} onModels={acceptModels} onImportBusyChange={busy=>{const key=drafts.groupId+mode;if(busy)importsInFlight.current.add(key);else importsInFlight.current.delete(key);setDraftImportBusy(importsInFlight.current.size>0);}} onSubmit={() => void tasks.submit(activeDraft)} submitting={tasks.submitting} submitDisabled={submitBlockers.length > 0} submitBlockers={submitBlockers} onChooseLibrary={() => {setPicking(true);navigate('library');}} /></fieldset>{alreadySubmitted && <div className="wb-notice"><p>此草稿已提交。再次创建会产生新的生成任务，可能再次计费。</p><button type="button" onClick={() => tasks.allowAnother(activeDraft)}>准备以相同草稿新建任务</button></div>}</div><TaskPreview key={tasks.selected?.localTaskId || page} task={tasks.selected} image={page === 'image'} now={tasks.now} onDetails={setDetails} onVideo={assets => void transferToVideo(assets)} onImageReference={asset => void transferToImage(asset)} /></div><section className="wb-panel wb-recents"><div className="wb-section-heading"><h2>{page === 'image' ? '最近图片结果与任务' : '最近视频任务'}</h2><button type="button" className="wb-link" onClick={() => setAllTasks(true)}>查看全部任务</button></div><p className="wb-help">当前显示：处理中 {recentTasks.filter(task=>taskExecutionActive(task)&&task.status!=='local_queued').length || 0} 项 · 等待处理 {recentTasks.filter(task=>taskExecutionActive(task)&&task.status==='local_queued').length || 0} 项。取消或超时后会为后续任务释放本地名额。</p>{tasks.error ? <p role="alert" className="wb-error">{tasks.error}</p> : !tasks.history ? <p>正在读取本机任务…</p> : !tasks.history.items.length ? <p className="wb-help">还没有生成任务</p> : <div className="wb-recent-list">{recentTasks.map(task => <MediaTaskCard key={task.localTaskId} task={task} now={tasks.now} onPreview={() => tasks.select(task)} onDetails={() => setDetails(task)} onChanged={() => void tasks.refresh()} onRegroup={()=>setRegrouping(task)} onRemoved={id=>{tasks.forget(id);setDetails(previous=>previous?.localTaskId===id?null:previous);}}/>)}</div>}</section></>}
    {allTasks && <WorkbenchAllTasks groupId={drafts.groupId} groups={groupState.groups} groupsReady={groupState.loaded} now={tasks.now} onClose={() => setAllTasks(false)} onDetails={setDetails} onRegroup={setRegrouping} onChanged={() => {void tasks.refresh();void groupState.refresh();setLibraryRevision(value=>value+1);}} onRemoved={tasks.forget}/>}
    {managingGroups && <GroupManager groups={groupState.groups} beforeDelete={beforeDeleteGroup} onClose={() => setManagingGroups(false)} onChanged={groupChanged}/>}
    {details && <TaskDetails key={details.localTaskId} task={details} fromLibrary={page==='library'} onRegroup={setRegrouping} onRemoved={id=>{tasks.forget(id);setDetails(null);}} now={tasks.now} onClose={() => setDetails(null)} onReuse={task => void reuse(task)} onVideo={assets => void transferToVideo(assets)} onImageReference={asset => void transferToImage(asset)} onChanged={() => {setLibraryRevision(value => value+1);void tasks.refresh();}} />}
    {regrouping && <GroupMoveDialog key={regrouping.localTaskId} task={regrouping} groups={groupState.groups} onClose={()=>setRegrouping(null)} onMoved={task=>{setDetails(previous=>previous?.localTaskId===task.localTaskId?task:previous);groupChanged();setNotice('分组已更新。实际位置：'+(task.outputLocation||'此任务暂无正式输出'));}}/>}
    {discardingIntent && <WorkbenchDialog title="结束本地意图核对" onClose={() => setDiscardingIntent(null)}><p>这只关闭此意图的本地核对提醒。已存在任务及其生成占位仍保留，远端可能继续生成或计费。重新新建相同内容可能产生重复费用。</p><div className="wb-actions"><button type="button" onClick={() => setDiscardingIntent(null)}>继续保留核对</button><button type="button" onClick={() => { void tasks.discard(discardingIntent).then(() => setDiscardingIntent(null)).catch(error => setNotice(localErrorMessage(error))); }}>确认结束本地核对</button></div></WorkbenchDialog>}
    {transfer && <WorkbenchDialog title="将内容带入草稿" onClose={() => setTransfer(null)}><p>{transfer.description}</p><p className="wb-warning">这会替换目标模式草稿中对应内容；原作品与任务记录保留。仅编辑草稿，不会自动生成。</p><div className="wb-actions"><button type="button" onClick={() => setTransfer(null)}>保留原草稿</button><button type="button" onClick={applyTransfer}>确认带入草稿</button></div></WorkbenchDialog>}
  </div></div>{updates.frozen && <div className="nova-workbench wb-update-overlay" role="status" aria-live="polite"><div className="wb-panel"><h2>{updates.state?.phase === 'installing' ? '正在启动安装程序…' : '正在保存并准备重启…'}</h2><p>请稍候，正在确认草稿与本机资料。远端任务可能仍在继续。</p></div></div>}</>;
}
