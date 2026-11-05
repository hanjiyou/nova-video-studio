import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_GROUP_ID, DRAFT_MODES, type Draft, type HistoryTask } from '@/lib/workbench-client';
import { acceptTask, currentTask, resetTaskStateForTests } from '@/lib/workbench-task-state';
import { groupOperationPending, renameTaskWork, resetGroupOperationsForTests } from '@/lib/workbench-group-client';
import { workNameError, workNameLength } from '@/lib/workbench-names';
import { useWorkbenchDrafts } from '@/hooks/useWorkbenchDrafts';
import { useWorkbenchTasks } from '@/hooks/useWorkbenchTasks';
import { reusableDraft } from '@/lib/workbench-generation';
import { novaTaskSocket } from '@/lib/ccode-task-socket';
import { WorkRenameDialog } from '../WorkRenameDialog';
import { MediaTaskCard } from '../MediaTaskCard';
import { DraftEditor } from '../DraftEditor';
import { WorkbenchLibrary } from '../WorkbenchLibrary';
import { WorkbenchLibraryPreview } from '../WorkbenchLibraryPreview';
import { AssetActions, TaskDetails, TaskPreview } from '../WorkbenchResults';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';

const id='44444444-4444-4444-8444-444444444444';
const asset={assetId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'image' as const,displayName:'原文件.png',mimeType:'image/png',byteLength:1,sha256:'synthetic',availability:'available' as const,validationState:'verified',previewUrl:'/synthetic/image.png'};
const task=(extra:Partial<HistoryTask>={}):HistoryTask=>({id,localTaskId:id,groupId:DEFAULT_GROUP_ID,groupName:'未分组',status:'completed',mode:'image.text',createdAt:'2026-11-05T01:00:00Z',completedAt:'2026-11-05T01:01:00Z',expiresAt:null,prompt:'男子拖着行李箱',model:'grok-synthetic',parameters:{},outputAssets:[asset],revision:1,nameRevision:0,...extra});
const draft=(groupId=DEFAULT_GROUP_ID,mode:Draft['mode']='image.text'):Draft=>({groupId,mode,prompt:'保留提示词',model:'',parameters:{},inputAssets:[],revision:0,updatedAt:null,workName:''});
const next=(before:HistoryTask,workName='镜头03'):HistoryTask=>({...before,workName,nameRevision:1,revision:2,outputAssets:[{...asset,assetId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:workName+'.png',previewUrl:'/synthetic/renamed.png'}]});
beforeEach(()=>{resetTaskStateForTests();resetGroupOperationsForTests();novaTaskSocket.disable();vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();delete window.novaDesktop;});

it('allows sixty Unicode characters and separates named title from full prompt without changing old unnamed cards',()=>{
 const unicode='😀'.repeat(60);expect(workNameLength(unicode)).toBe(60);expect(workNameError(unicode)).toBe('');expect(workNameError(unicode+'中')).toContain('60');expect(workNameError('名称\n换行')).toBeTruthy();
 const view=render(<MediaTaskCard task={task({workName:'镜头03'})} onDetails={vi.fn()} onPreview={vi.fn()}/>);
 expect(screen.getByRole('button',{name:'预览任务：镜头03'})).toBeInTheDocument();expect(screen.getByText('男子拖着行李箱')).toBeInTheDocument();
 view.rerender(<MediaTaskCard task={task()} onDetails={vi.fn()} onPreview={vi.fn()}/>);expect(screen.getByRole('button',{name:'预览任务：男子拖着行李箱'})).toBeInTheDocument();
});

it.each(['image.text','video.text','video.single_reference','video.dual_reference'] as const)('shares the optional name field in %s without replacing prompt or adding save notifications',mode=>{
 function Editor(){const[value,setValue]=useState(draft(DEFAULT_GROUP_ID,mode));return <DraftEditor draft={value} connection={null} models={null} saving={false} onChange={patch=>setValue({...value,...patch})} onConfigure={vi.fn()} onRetry={vi.fn()} onReload={vi.fn()}/>;}
 render(<Editor/>);fireEvent.change(screen.getByLabelText(/作品名称/),{target:{value:'镜头😀'}});expect(screen.getByLabelText(/作品名称/)).toHaveValue('镜头😀');expect(screen.getByText('3/60')).toBeInTheDocument();expect(screen.getByRole('textbox',{name:mode==='image.text'?'画面描述':'剧情描述'})).toHaveValue('保留提示词');expect(screen.getByLabelText('草稿保存状态')).toHaveTextContent('草稿自动保存');
});

it('persists work names through group and mode switches without borrowing another draft name',async()=>{
 const rows=new Map<string,Draft>();const other='11111111-1111-4111-8111-111111111111';
 vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{const group=route.includes('/groups/')?route.split('/groups/')[1].split('/')[0]:DEFAULT_GROUP_ID,mode=route.split('/').at(-1) as Draft['mode'],key=group+mode;let value=rows.get(key)||draft(group,mode);if(init?.method==='PUT'){const body=JSON.parse(String(init.body));value={...value,...body,revision:body.expectedRevision+1};rows.set(key,value);}return Response.json({draft:value});}));
 const hook=renderHook(useWorkbenchDrafts);await act(async()=>hook.result.current.load());act(()=>hook.result.current.update('image.text',{workName:'图片名称'}));await act(async()=>hook.result.current.flush());
 await act(async()=>hook.result.current.switchGroup(other));expect(hook.result.current.drafts['image.text']?.workName).toBe('');act(()=>hook.result.current.update('video.text',{workName:'其他组视频'}));await act(async()=>hook.result.current.flush());await act(async()=>hook.result.current.switchGroup(DEFAULT_GROUP_ID));
 expect(hook.result.current.drafts['image.text']?.workName).toBe('图片名称');expect(hook.result.current.drafts['video.text']?.workName).toBe('');expect(DRAFT_MODES).toHaveLength(4);
});

it('freezes the entered name in one local submission, leaves upstream creation unchanged and reuses current name',async()=>{
 const connection:ConnectionSummary={connectionId:'11111111-1111-4111-8111-111111111111',connectionVersionId:'22222222-2222-4222-8222-222222222222',displayName:'synthetic',baseUrl:'https://newapi.opensosen.com/v1',provider:'opensosen',protocol:'openai',hasCredential:true,credentialState:'ready',validationState:'verified',lastCheckedAt:null,lastSuccessAt:null,modelsFetchedAt:null,errorCode:null,defaultImageModel:'synthetic-model',defaultVideoModel:'synthetic-video',isDefault:true};
 const capability={capabilityVersionId:'33333333-3333-4333-8333-333333333333',provider:connection.provider,baseUrl:connection.baseUrl,model:'synthetic-model',mode:'image.text',protocol:'openai',parameters:{},evidenceLevel:'historically_verified',evidenceVersion:'synthetic',evidence:{sourceIds:['synthetic'],applicationVerified:false}};
 const models:ConnectionModels={connectionVersionId:connection.connectionVersionId,modelsFetchedAt:null,models:[{model:'synthetic-model',visibility:'visible'}],capabilities:[capability]};
 const calls:Array<{route:string;body:any}>=[];
 vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{const body=init?.body?JSON.parse(String(init.body)):null;calls.push({route,body});if(route.startsWith('/api/nova/storage/tasks?'))return Response.json({items:[],total:0});if(route==='/api/nova/storage/submissions')return Response.json(init?.method==='POST'?{input:body}:{items:[]});if(route.endsWith('/attempt'))return Response.json({marked:true});if(route==='/api/nova/workbench/tasks')return Response.json({taskId:id});if(route==='/api/nova/storage/tasks/'+id)return Response.json({task:task({workName:'提交名称'})});if(init?.method==='DELETE')return Response.json({dismissed:true});throw Error(route);}));
 const hook=renderHook(()=>useWorkbenchTasks(true,'image',connection,models));await waitFor(()=>expect(hook.result.current.reconciliationReady).toBe(true));const named={...draft(),model:'synthetic-model',workName:'  提交名称  '};await act(async()=>hook.result.current.submit(named));
 expect(calls.find(item=>item.route==='/api/nova/storage/submissions'&&item.body)?.body.workName).toBe('提交名称');expect(calls.filter(item=>item.route==='/api/nova/workbench/tasks')).toHaveLength(1);expect(calls.find(item=>item.route==='/api/nova/workbench/tasks')?.body.prompt).toBe('保留提示词');expect(reusableDraft(task({workName:'后来修改的名称'})).workName).toBe('后来修改的名称');
});

it('renames a historical work and refreshes the same library filter so a nonmatching renamed row disappears',async()=>{
 let item=task({workName:'镜头03'});const requests:URL[]=[],posts:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{if(init?.method==='POST'){posts.push(JSON.parse(String(init.body)));item=next(item,'海边相遇');return Response.json({task:item,taskId:id});}const url=new URL(route,'http://synthetic.invalid');requests.push(url);const matches=!url.searchParams.get('search')||url.searchParams.get('search')==='镜头03'&&item.workName==='镜头03';return Response.json({items:matches?[item]:[],total:matches?1:0,unfilteredTotal:1});}));
 render(<WorkbenchLibrary revision={0} onDetails={vi.fn()} onVideo={vi.fn()} onImage={vi.fn()}/>);await screen.findByRole('button',{name:'预览作品：镜头03'});fireEvent.change(screen.getByLabelText('搜索名称、提示词或模型'),{target:{value:'镜头03'}});await screen.findByRole('button',{name:'预览作品：镜头03'});fireEvent.click(screen.getByLabelText('更多作品操作'));fireEvent.click(screen.getByRole('button',{name:'重命名'}));
 let dialog=screen.getByRole('dialog',{name:'重命名作品'});expect(within(dialog).getByLabelText('作品名称')).toHaveValue('镜头03');fireEvent.change(within(dialog).getByLabelText('作品名称'),{target:{value:'海边相遇'}});fireEvent.click(within(dialog).getByRole('button',{name:'保存名称'}));await waitFor(()=>expect(posts).toHaveLength(1));
 expect(posts[0]).toMatchObject({workName:'海边相遇',expectedNameRevision:0});await screen.findByText('没有符合筛选条件的作品');expect(requests.at(-1)?.searchParams.get('search')).toBe('镜头03');expect(screen.getByLabelText('搜索名称、提示词或模型')).toHaveValue('镜头03');
});

it('holds one request and the original name revision while a rename receipt is unknown, including newer WS state',async()=>{
 const before=task({workName:'原名'}),after=next(before,'新名'),posts:Array<{requestId:string;workName:string;expectedNameRevision:number}>=[];let call=0;
 vi.stubGlobal('fetch',vi.fn(async(_route,init)=>{posts.push(JSON.parse(init.body));if(++call===1)throw Error('offline');return Response.json({task:after,taskId:id});}));
 const renamed=vi.fn();render(<WorkRenameDialog task={before} onClose={vi.fn()} onRenamed={renamed}/>);fireEvent.change(screen.getByLabelText('作品名称'),{target:{value:'新名'}});fireEvent.click(screen.getByRole('button',{name:'保存名称'}));await screen.findByRole('button',{name:'核对原改名请求'});expect(screen.getByLabelText('作品名称')).toBeDisabled();
 act(()=>acceptTask(after));fireEvent.click(screen.getByRole('button',{name:'核对原改名请求'}));await waitFor(()=>expect(renamed).toHaveBeenCalledWith(after,undefined));expect(posts[0]).toEqual(posts[1]);expect(posts[1].expectedNameRevision).toBe(0);expect(currentTask(before).workName).toBe('新名');
});

it('merges duplicate renames under the shared file-operation lock and keeps newer names against stale refresh',async()=>{
 const before=task(),after=next(before);let resolve!:(value:Response)=>void;const response=new Promise<Response>(done=>resolve=done),fetcher=vi.fn(()=>response);vi.stubGlobal('fetch',fetcher);
 const first=renameTaskWork(before,'镜头03'),second=renameTaskWork(before,'镜头03');expect(groupOperationPending('task:'+id)).toBe(true);await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));resolve(Response.json({task:after,taskId:id}));await first;await second;acceptTask(before);expect(currentTask(before).workName).toBe('镜头03');
});

it('blocks active work renames and surfaces definitive file failures without claiming success',async()=>{
 const active=render(<WorkRenameDialog task={task({status:'downloading',localExecutionActive:true})} onClose={vi.fn()} onRenamed={vi.fn()}/>);expect(screen.getByRole('button',{name:'保存名称'})).toBeDisabled();expect(screen.getByText(/请等待结束后再改名/)).toBeInTheDocument();active.unmount();
 const renamed=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({code:'WORK_RENAME_FAILED'},{status:409})));render(<WorkRenameDialog task={task()} onClose={vi.fn()} onRenamed={renamed}/>);fireEvent.change(screen.getByLabelText('作品名称'),{target:{value:'新名'}});fireEvent.click(screen.getByRole('button',{name:'保存名称'}));await screen.findByRole('alert');expect(screen.getByRole('alert')).toHaveTextContent('原名称与文件保留');expect(renamed).not.toHaveBeenCalled();expect(screen.getByLabelText('作品名称')).not.toBeDisabled();
});

it('provides rename from library preview and task details while saving copies with validated task context',async()=>{
 window.novaDesktop={saveAssetCopy:vi.fn(async()=>({ok:true})),revealAsset:vi.fn(async()=>({ok:true}))} as unknown as Window['novaDesktop'];
 const item=task({workName:'镜头03'}),view=render(<WorkbenchLibraryPreview task={item} onClose={vi.fn()}/>);expect(screen.getByText('镜头03')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'另存副本'}));await waitFor(()=>expect(window.novaDesktop?.saveAssetCopy).toHaveBeenCalledWith(asset.assetId,id));fireEvent.click(screen.getByRole('button',{name:'重命名'}));expect(screen.getByRole('dialog',{name:'重命名作品'})).toBeInTheDocument();view.unmount();
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task:item})));const details=render(<TaskDetails task={item} now={Date.now()} onClose={vi.fn()} onReuse={vi.fn()} onVideo={vi.fn()} onChanged={vi.fn()}/>);await waitFor(()=>expect(fetch).toHaveBeenCalled());fireEvent.click(screen.getByLabelText('更多任务操作'));fireEvent.click(screen.getByRole('button',{name:'重命名'}));expect(screen.getByRole('dialog',{name:'重命名作品'})).toBeInTheDocument();details.unmount();
 render(<AssetActions asset={asset}/>);fireEvent.click(screen.getByRole('button',{name:'另存副本'}));await waitFor(()=>expect(window.novaDesktop?.saveAssetCopy).toHaveBeenLastCalledWith(asset.assetId));
});

it('releases both library and generation video sources before a rename and restores them without autoplay',()=>{
 const item=task({mode:'video.text',outputAssets:[{...asset,kind:'video',mimeType:'video/mp4',previewUrl:'/synthetic/video.mp4'}]});
 const library=render(<WorkbenchLibraryPreview task={item} onClose={vi.fn()}/>);let player=screen.getByLabelText('作品库视频预览') as HTMLVideoElement;expect(player).toHaveAttribute('src','/synthetic/video.mp4');fireEvent.click(screen.getByRole('button',{name:'重命名'}));expect(player).not.toHaveAttribute('src');fireEvent.click(within(screen.getByRole('dialog',{name:'重命名作品'})).getByRole('button',{name:'取消'}));expect(player).toHaveAttribute('src','/synthetic/video.mp4');expect(player).not.toHaveAttribute('autoplay');library.unmount();
 const view=render(<TaskPreview task={item} image={false} now={Date.now()} onDetails={vi.fn()} onVideo={vi.fn()}/>);player=view.container.querySelector('video')!;fireEvent.click(screen.getByRole('button',{name:'重命名'}));expect(player).not.toHaveAttribute('src');expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
});

it('recovers a concurrent-name conflict by explicitly reading the latest revision while preserving typed input',async()=>{
 const before=task({workName:'原名'}),latest=task({workName:'其他人改名',nameRevision:4,revision:5}),updated=task({workName:'我的修改',nameRevision:5,revision:6}),posts:Array<{expectedNameRevision:number}>=[];
 vi.stubGlobal('fetch',vi.fn(async(_route,init)=>{if(init?.method==='POST'){posts.push(JSON.parse(String(init.body)));return posts.length===1?Response.json({code:'WORK_NAME_REVISION_CONFLICT'},{status:409}):Response.json({task:updated,taskId:id});}return Response.json({task:latest});}));
 const renamed=vi.fn();render(<WorkRenameDialog task={before} onClose={vi.fn()} onRenamed={renamed}/>);fireEvent.change(screen.getByLabelText('作品名称'),{target:{value:'我的修改'}});fireEvent.click(screen.getByRole('button',{name:'保存名称'}));await screen.findByRole('button',{name:'读取最新作品信息（保留输入）'});expect(screen.getByRole('button',{name:'保存名称'})).toBeDisabled();expect(posts).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'读取最新作品信息（保留输入）'}));await screen.findByText('已读取最新作品信息，当前输入仍保留。请核对后再次保存。');expect(screen.getByLabelText('作品名称')).toHaveValue('我的修改');expect(screen.getByRole('button',{name:'保存名称'})).not.toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'保存名称'}));await waitFor(()=>expect(renamed).toHaveBeenCalled());expect(posts.map(item=>item.expectedNameRevision)).toEqual([0,4]);
});

it('reports a committed rename with pending source cleanup as success requiring later organization',async()=>{
 const before=task(),after=next(before);vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task:after,taskId:id,cleanupPending:true})));
 render(<WorkbenchLibraryPreview task={before} onClose={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'重命名'}));fireEvent.change(screen.getByLabelText('作品名称'),{target:{value:'镜头03'}});fireEvent.click(screen.getByRole('button',{name:'保存名称'}));await screen.findByText('名称与文件名已更新，旧文件整理尚待恢复。');expect(screen.getByText('镜头03')).toBeInTheDocument();
});
