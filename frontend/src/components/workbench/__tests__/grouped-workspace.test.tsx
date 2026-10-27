import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchDrafts } from '@/hooks/useWorkbenchDrafts';
import { useWorkbenchTasks } from '@/hooks/useWorkbenchTasks';
import { DEFAULT_GROUP_ID, DRAFT_MODES, type Draft, type HistoryTask, type WorkbenchGroup } from '@/lib/workbench-client';
import { resetTaskStateForTests } from '@/lib/workbench-task-state';
import { WorkbenchLibrary } from '../WorkbenchLibrary';
import { WorkbenchAllTasks } from '../WorkbenchAllTasks';
import { MediaTaskCard } from '../MediaTaskCard';
import { WorkbenchShell } from '../WorkbenchShell';
import { GroupPicker } from '../WorkbenchGroups';
import { novaTaskSocket } from '@/lib/ccode-task-socket';
import { WorkbenchDialog } from '../WorkbenchResults';
const other = '11111111-1111-4111-8111-111111111111';
const groups: WorkbenchGroup[] = [{ groupId: DEFAULT_GROUP_ID, name: '未分组', isDefault: true, createdAt: '', outputLocation: 'D:/测试输出/assets/未分组', workCount: 2, taskCount: 4 }, { groupId: other, name: '海边短片', isDefault: false, createdAt: '', outputLocation: 'D:/测试输出/assets/海边短片', workCount: 1, taskCount: 3 }];
const value = (groupId = DEFAULT_GROUP_ID, mode: Draft['mode'] = 'image.text', prompt = ''): Draft => ({ groupId, mode, prompt, model: '', parameters: {}, inputAssets: [], revision: 0, updatedAt: null });
const task = (id: string, groupId = DEFAULT_GROUP_ID): HistoryTask => ({ id, localTaskId: id, groupId, groupName: groups.find(group => group.groupId === groupId)?.name, status: 'failed', mode: 'image.text', prompt: id, model: 'synthetic-model', createdAt: '2026-10-27T01:00:00.000Z', completedAt: null, expiresAt: null, parameters: {} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function draftApi(override?: (route: string, init?: RequestInit) => Promise<Response> | undefined) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (route: string, init?: RequestInit) => {
    calls.push(route); const intercepted = override?.(route, init); if (intercepted) return intercepted;
    const group = route.includes('/groups/') ? route.split('/groups/')[1].split('/')[0] : DEFAULT_GROUP_ID, mode = route.split('/').pop() as Draft['mode'];
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    return Response.json({ draft: { ...value(group, mode, group === other ? '其他组草稿' : ''), ...(body || {}), revision: body ? body.expectedRevision + 1 : 0 } });
  })); return calls;
}
beforeEach(() => {resetTaskStateForTests();novaTaskSocket.disable();vi.spyOn(window,'scrollTo').mockImplementation(()=>{});});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('group switch waits for successful flush, locks edits and overlapping switches, then loads all modes', async () => {
  const save = deferred<Response>(); const calls = draftApi((route, init) => init?.method === 'PUT' ? save.promise : undefined);
  const hook = renderHook(useWorkbenchDrafts); await act(async () => hook.result.current.load());
  act(() => hook.result.current.update('image.text', { prompt: '原草稿' })); await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'PUT')).toBe(true));
  let switching!: Promise<boolean>; act(() => { switching = hook.result.current.switchGroup(other); });
  expect(hook.result.current.switching).toBe(true); expect(calls.some(route => route.includes('/groups/'))).toBe(false);
  act(() => hook.result.current.update('image.text', { prompt: '不应落入旧组' })); expect(hook.result.current.drafts['image.text']?.prompt).toBe('原草稿');
  await act(async () => { await expect(hook.result.current.switchGroup('another')).resolves.toBe(false); });
  await act(async () => { save.resolve(Response.json({ draft: { ...value(DEFAULT_GROUP_ID, 'image.text', '原草稿'), revision: 1 } })); await switching; });
  expect(hook.result.current.groupId).toBe(other); expect(hook.result.current.drafts['image.text']?.prompt).toBe('其他组草稿');
  expect(calls.filter(route => route.includes('/groups/'))).toHaveLength(DRAFT_MODES.length);
});
it('failed source save preserves current group and every input instead of silently switching', async () => {
  const calls = draftApi((_route, init) => init?.method === 'PUT' ? Promise.resolve(Response.json({ code: 'DRAFT_REVISION_CONFLICT' }, { status: 409 })) : undefined);
  const hook = renderHook(useWorkbenchDrafts); await act(async () => hook.result.current.load()); act(() => hook.result.current.update('video.text', { prompt: '必须保留' }));
  await act(async () => { await expect(hook.result.current.switchGroup(other)).rejects.toThrow('UPDATE_SAVE_FAILED'); });
  expect(hook.result.current.groupId).toBe(DEFAULT_GROUP_ID); expect(hook.result.current.drafts['video.text']?.prompt).toBe('必须保留'); expect(calls.some(route => route.includes('/groups/'))).toBe(false);
});
it('late old-group reload cannot write into a new group or clear its edits', async () => {
  const old = deferred<Response>(); let reload = false;
  draftApi((route, init) => reload && !init && route.endsWith('/drafts/image.text') && !route.includes('/groups/') ? old.promise : undefined);
  const hook = renderHook(useWorkbenchDrafts); await act(async () => hook.result.current.load()); reload = true;
  let pending!: Promise<void>; act(() => { pending = hook.result.current.reload('image.text'); });
  await act(async () => { await hook.result.current.switchGroup(other); });
  act(() => hook.result.current.update('image.text', { prompt: '新组修改' }));
  await act(async () => { old.resolve(Response.json({ draft: value(DEFAULT_GROUP_ID, 'image.text', '迟到旧组') })); await pending; });
  expect(hook.result.current.groupId).toBe(other); expect(hook.result.current.drafts['image.text']).toMatchObject({ groupId: other, prompt: '新组修改' });
});
it('reload never overwrites typing that occurred after its read began', async () => {
  const old = deferred<Response>(); let reload = false;
  draftApi((route, init) => reload && !init && route.endsWith('/image.text') ? old.promise : undefined);
  const hook = renderHook(useWorkbenchDrafts); await act(async () => hook.result.current.load()); reload = true;
  let pending!: Promise<void>; act(() => { pending = hook.result.current.reload('image.text'); hook.result.current.update('image.text', { prompt: '读后输入' }); });
  await act(async () => { old.resolve(Response.json({ draft: value(DEFAULT_GROUP_ID, 'image.text', '旧读取') })); await pending; });
  expect(hook.result.current.drafts['image.text']?.prompt).toBe('读后输入');
});
it('late recent-task group response cannot select or render the old group', async () => {
  const old = deferred<Response>(), requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (route: string) => {
    if (route.endsWith('/submissions')) return Response.json({ items: [] }); requests.push(route);
    const group = new URL(route, 'http://synthetic.invalid').searchParams.get('groupId');
    return group === DEFAULT_GROUP_ID ? old.promise : Response.json({ items: [task('新组任务', other)], total: 1 });
  }));
  const hook = renderHook(({ groupId }) => useWorkbenchTasks(true, 'image', null, null, undefined, 6, groupId), { initialProps: { groupId: DEFAULT_GROUP_ID } });
  await waitFor(() => expect(requests).toHaveLength(1)); hook.rerender({ groupId: other });
  await act(async () => old.resolve(Response.json({ items: [task('迟到任务')], total: 1 })));
  await waitFor(() => expect(hook.result.current.history?.items[0].localTaskId).toBe('新组任务')); expect(hook.result.current.selected?.groupId).toBe(other);
});
it('library joins group/type/search on the server and removes task status filtering', async () => {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (route: string) => { requests.push(new URL(route, 'http://synthetic.invalid')); return Response.json({ items: [task('库结果', other)], total: 1 }); }));
  render(<WorkbenchLibrary revision={0} groups={groups} onDetails={vi.fn()} onVideo={vi.fn()} onImage={vi.fn()}/>);
  await screen.findByText('库结果'); expect(screen.queryByLabelText('任务状态')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '海边短片1' })); fireEvent.change(screen.getByLabelText('作品类型'), { target: { value: 'video' } }); fireEvent.change(screen.getByLabelText('搜索提示词或模型'), { target: { value: '海边' } });
  await waitFor(() => expect(requests.at(-1)?.searchParams.get('search')).toBe('海边'));
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({ scope: 'library', groupId: other, kind: 'video', search: '海边', offset: '0' }); expect(requests.at(-1)!.searchParams.has('status')).toBe(false);
});
it('all tasks uses server category and pagination, preserves unknown/paused records, and never creates generation', async () => {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (route: string) => { const url = new URL(route, 'http://synthetic.invalid'); requests.push(url); const offset = Number(url.searchParams.get('offset')); return Response.json({ items: [{ ...task(offset ? '查询暂停' : '回执待核对'), status: offset ? 'polling_paused' : 'submission_unknown' }], total: 13 }); }));
  render(<WorkbenchAllTasks groupId={other} groups={groups} now={Date.now()} onClose={vi.fn()} onDetails={vi.fn()} onChanged={vi.fn()} onRemoved={vi.fn()} onRegroup={vi.fn()}/>);
  await screen.findByText('回执待核对'); fireEvent.change(screen.getByLabelText('任务分类'), { target: { value: 'unfinished' } });
  await waitFor(() => expect(requests.at(-1)?.searchParams.get('category')).toBe('unfinished')); await waitFor(() => expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '下一页' })); await screen.findByText('查询暂停');
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({ scope: 'workbench', groupId: other, category: 'unfinished', offset: '12' }); expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method)).toBe(true);
});
it('cards keep remote billing warnings, compact completed timing and multioutput semantics without a fake percentage', () => {
  const output = { assetId: 'a', kind: 'image' as const, displayName: 'a.png', mimeType: 'image/png', byteLength: 1, sha256: 's', availability: 'available' as const, validationState: 'verified', previewUrl: '/synthetic' };
  const props = { onPreview: vi.fn(), onDetails: vi.fn() };
  const view = render(<MediaTaskCard task={{ ...task('完成'), status: 'completed', outputAssets: [output, { ...output, assetId: 'b' }] }} {...props}/>);
  expect(screen.getByText('2 个输出')).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('时限');
  view.rerender(<MediaTaskCard task={{ ...task('失败'), remoteMayContinue: true, taskError: { code: 'unknown', phase: 'submit', message: '真实错误', retryAction: 'none', transmission: 'may_have_reached_upstream', localTaskId: '失败' } }} {...props}/>);
  expect(screen.getByText('真实错误')).toBeInTheDocument(); expect(screen.getByText(/远端可能仍在生成或计费/)).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('%');
});
it('dialog tab trap skips actions inside a closed native menu', () => {
  render(<WorkbenchDialog title="菜单焦点" onClose={vi.fn()}><button type="button">可见动作</button><details><summary>更多</summary><button type="button">隐藏动作</button></details></WorkbenchDialog>);
  const dialog = screen.getByRole('dialog'), summary = within(dialog).getByText('更多'); summary.focus(); fireEvent.keyDown(summary, { key: 'Tab' });
  expect(within(dialog).getByRole('button', { name: '关闭对话框' })).toHaveFocus();
});

it.each(['validating','saving'] as const)('card stage follows active download %s even with a coarse downloading status and inline asset', phase => {
 const value = {...task('阶段'),status:'downloading' as const,localOutcome:'failed' as const,downloadAttempt:{id:'a',active:true,startedAt:null,deadlineAt:null,timeoutSeconds:30,outcome:null,finishedAt:null},downloadProgress:{attemptId:'a',attemptNumber:2,retryCount:1,phase,fileIndex:1,fileCount:1,transferNumber:1,sourceKind:'asset',receivedBytes:10,totalBytes:10,bytesPerSecond:100,percent:100,savedFileCount:0,overallReceivedBytes:10,overallTotalBytes:10,reusedBytes:0,completedBytes:10,elapsedMs:1,lastByteAt:null,startedAt:null,deadlineAt:null,timeoutSeconds:30,stalled:false}};
 render(<MediaTaskCard task={value} onPreview={vi.fn()} onDetails={vi.fn()}/>);expect(screen.getAllByText(phase==='validating'?'校验中':'保存中')).toHaveLength(1);expect(screen.queryByText('下载中')).not.toBeInTheDocument();expect(screen.getByText('结果已接收')).toBeInTheDocument();
});
it('late editor callback is bound to its source group after switching', async () => {
 draftApi();const hook=renderHook(useWorkbenchDrafts);await act(async()=>hook.result.current.load());await act(async()=>{await hook.result.current.switchGroup(other);});act(()=>hook.result.current.update('image.text',{prompt:'旧组迟到导入'},undefined,DEFAULT_GROUP_ID));expect(hook.result.current.drafts['image.text']?.prompt).toBe('其他组草稿');
});

function shellGroupApi(code?: string, archived = false, repairFails = false) {
 let deleted=false;let preferences={activePage:'image',activeMode:'image.text',activeGroupId:other};const puts:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{
  if(route==='/api/nova/connections/current')return Response.json({connection:null});
  if(route==='/api/nova/storage/groups/'+other&&init?.method==='DELETE'){deleted=true;return Response.json({groupId:other,deleted:true});}
  if(route==='/api/nova/storage/groups')return Response.json({items:groups.filter(group=>!deleted||group.groupId!==other).map(g=>({...g,archived:g.groupId===other&&archived})),defaultGroupId:DEFAULT_GROUP_ID});
  if(route.includes('/settings/')){const key=route.split('/').pop();if(init?.method==='PUT'){puts.push(JSON.parse(String(init.body)));if(repairFails)return Response.json({code:'SETTING_REVISION_CONFLICT'},{status:409});preferences=JSON.parse(String(init.body)).value;}return Response.json({setting:{key,value:key==='workspace'?preferences:key==='onboarding'?{dismissed:true}:null,revision:1,updatedAt:null}});}
  if(route.includes('/drafts/')){const groupId=route.includes('/groups/')?other:DEFAULT_GROUP_ID;if(code&&groupId===other)return Response.json({code},{status:404});return Response.json({draft:value(groupId,route.split('/').pop() as Draft['mode'])});}
  if(route.endsWith('/submissions'))return Response.json({items:[]});
  if(route.includes('/tasks?'))return Response.json({items:[],total:0});throw Error(route);
 }));return puts;
}
it('deleted saved group repairs only the group setting and boots safely with a clear notice',async()=>{
 const puts=shellGroupApi('GROUP_NOT_FOUND');render(<WorkbenchShell/>);await screen.findByRole('navigation',{name:'主要导航'});expect(screen.getByLabelText('所属剧本')).toHaveValue(DEFAULT_GROUP_ID);expect(screen.getByText(/原剧本分组已不存在/)).toBeInTheDocument();expect(puts).toEqual([{value:{activePage:'image',activeMode:'image.text',activeGroupId:DEFAULT_GROUP_ID},expectedRevision:1}]);
});
it('group IO failure is not hidden by resetting a saved group',async()=>{
 const puts=shellGroupApi('STORAGE_OPERATION_FAILED');render(<WorkbenchShell/>);await screen.findByRole('heading',{name:'暂时无法读取本机工作台'});expect(puts).toEqual([]);expect(screen.queryByRole('navigation',{name:'主要导航'})).not.toBeInTheDocument();
});
it('archived draft remains readable and shows the explicit generation block',async()=>{
 shellGroupApi(undefined,true);render(<WorkbenchShell/>);await screen.findByRole('navigation',{name:'主要导航'});expect(screen.getByLabelText('所属剧本')).toHaveValue(other);expect(screen.getByText('当前剧本已归档，请选择可用剧本后生成。')).toBeInTheDocument();
});
it('group selector keeps a pending current identity visible and shows the correct media directory',()=>{
 const view=render(<GroupPicker groups={[groups[0]]} groupId={other} mediaKind="video" onChange={vi.fn()} onManage={vi.fn()}/>);expect(screen.getByLabelText('所属剧本')).toHaveValue(other);expect(screen.getByRole('option',{name:'当前剧本（正在读取）'})).toBeInTheDocument();view.rerender(<GroupPicker groups={groups} groupId={other} mediaKind="video" onChange={vi.fn()} onManage={vi.fn()}/>);expect(screen.getByText('D:/测试输出/assets/海边短片\\视频')).toBeInTheDocument();
});

it('library marks missing previously saved output even when a later retry left a failed status',()=>{
 const output={assetId:'missing',kind:'video' as const,displayName:'失效.mp4',mimeType:'video/mp4',byteLength:1,sha256:'s',availability:'missing' as const,validationState:'verified',previewUrl:'/missing'};render(<MediaTaskCard task={{...task('旧保存结果'),status:'download_failed',savedAt:'2026-10-27T01:00:00Z',outputAssets:[output]}} variant="library" onPreview={vi.fn()} onDetails={vi.fn()}/>);expect(screen.getByText('结果文件缺失或损坏')).toBeInTheDocument();expect(screen.queryByText('下载失败')).not.toBeInTheDocument();
});

it('deleting the active empty group flushes and switches to default before settings and deletion',async()=>{
 shellGroupApi();render(<WorkbenchShell/>);await screen.findByRole('navigation',{name:'主要导航'});expect(screen.getByLabelText('所属剧本')).toHaveValue(other);fireEvent.click(screen.getByRole('button',{name:'管理分组'}));fireEvent.click(screen.getByRole('button',{name:'删除空分组'}));fireEvent.click(screen.getByRole('button',{name:'确认删除空分组'}));await screen.findByText('空分组已删除。');const calls=vi.mocked(fetch).mock.calls,remove=calls.findIndex(call=>call[1]?.method==='DELETE'),save=calls.findIndex(call=>call[1]?.method==='PUT'&&String(call[0]).endsWith('/settings/workspace'));expect(save).toBeGreaterThan(-1);expect(remove).toBeGreaterThan(save);fireEvent.click(screen.getByRole('button',{name:'关闭对话框'}));expect(screen.getByLabelText('所属剧本')).toHaveValue(DEFAULT_GROUP_ID);
});
