import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { WorkbenchLibrary } from '../WorkbenchLibrary';
import { LibraryVideoPreview,stopLibraryPreviews } from '../LibraryVideoPreview';
import { libraryDateBounds,libraryDateLabel,localDate,localDay } from '@/lib/library-date-filter';
import { moveLibraryTasks } from '@/lib/library-group-batch';
import { DEFAULT_GROUP_ID,type HistoryTask,type WorkbenchGroup } from '@/lib/workbench-client';
import { resetGroupOperationsForTests } from '@/lib/workbench-group-client';
import { resetTaskStateForTests } from '@/lib/workbench-task-state';
const other='11111111-1111-4111-8111-111111111111';
const groups:WorkbenchGroup[]=[{groupId:DEFAULT_GROUP_ID,name:'未分组',isDefault:true,createdAt:'',outputLocation:''},{groupId:other,name:'海边短片',isDefault:false,createdAt:'',outputLocation:''}];
const row=(id:string,kind:'image'|'video'='image',groupId=DEFAULT_GROUP_ID):HistoryTask=>({id,localTaskId:id,groupId,groupRevision:1,status:'completed',revision:1,mode:kind==='image'?'image.text':'video.text',createdAt:'2026-10-31T01:00:00.000Z',completedAt:'2026-10-31T01:01:00.000Z',expiresAt:null,prompt:id,model:'synthetic',parameters:{},outputAssets:[{assetId:id,kind,displayName:id+(kind==='image'?'.png':'.mp4'),mimeType:kind==='image'?'image/png':'video/mp4',byteLength:1,sha256:'synthetic',availability:'available',validationState:'verified',previewUrl:'/synthetic/'+id}]});
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
const props={revision:0,groups,onDetails:vi.fn(),onVideo:vi.fn(),onImage:vi.fn()};
beforeEach(()=>{vi.spyOn(document,'hasFocus').mockReturnValue(true);resetTaskStateForTests();resetGroupOperationsForTests();vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function api(initial:HistoryTask[],post?:(task:HistoryTask,body:{groupId:string;requestId:string},call:number)=>Promise<Response>,total?:number){
 let rows=initial;const requests:URL[]=[],posts:Array<{id:string;body:{groupId:string;requestId:string}}>=[];vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{
  const url=new URL(route,'http://synthetic.invalid');requests.push(url);
  if(init?.method==='POST'){const id=decodeURIComponent(url.pathname.split('/').at(-2)!),body=JSON.parse(String(init.body)),task=rows.find(t=>t.localTaskId===id)!;posts.push({id,body});if(post)return post(task,body,posts.length);const after={...task,groupId:body.groupId,groupRevision:2,revision:2};rows=rows.map(t=>t.localTaskId===id?after:t);return Response.json({task:after,movedFiles:1});}
  return Response.json({items:rows,total:total??rows.length,unfilteredTotal:total??rows.length});
 }));return{requests,posts};
}
function selected(name:string){return screen.getByRole('checkbox',{name:'选择作品：'+name});}
it('local date bounds include both natural days, account for local timezone, leap day and invalid inputs',()=>{
 const value={mode:'custom' as const,start:'2024-02-29',end:'2024-03-01'},bounds=libraryDateBounds(value);
 expect(bounds).toEqual({createdFrom:new Date(2024,1,29).toISOString(),createdBefore:new Date(2024,2,2).toISOString()});
 expect(localDate('2023-02-29')).toBeNull();expect(localDate('2026-13-01')).toBeNull();expect(localDate('2026-1-01')).toBeNull();
 expect(()=>libraryDateBounds({...value,start:'2024-03-02'})).toThrow();expect(()=>libraryDateBounds({...value,end:''})).toThrow();
 expect(libraryDateBounds({mode:'all',start:'',end:''})).toEqual({});
 expect(libraryDateBounds({mode:'today',start:'',end:''},new Date(2026,9,31,23,59))).toEqual({createdFrom:new Date(2026,9,31).toISOString(),createdBefore:new Date(2026,10,1).toISOString()});
});
it('date custom selection reaches the server before pagination; invalid draft and cancel never apply',async()=>{
 const calls=api([row('日期')],undefined,50);render(<WorkbenchLibrary {...props}/>);await screen.findByText('日期');
 fireEvent.click(screen.getByRole('button',{name:'下一页'}));await waitFor(()=>expect(calls.requests.at(-1)?.searchParams.get('offset')).toBe('24'));
 fireEvent.click(screen.getByRole('button',{name:'作品日期：全部日期'}));fireEvent.click(screen.getByRole('radio',{name:'自定义范围'}));
 fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-10-31'}});fireEvent.change(screen.getByLabelText('结束日期'),{target:{value:'2026-10-30'}});const count=calls.requests.length;fireEvent.click(screen.getByRole('button',{name:'应用'}));expect(screen.getByRole('alert')).toHaveTextContent('开始日期不能晚于结束日期');expect(calls.requests).toHaveLength(count);
 fireEvent.change(screen.getByLabelText('结束日期'),{target:{value:'2026-11-01'}});fireEvent.click(screen.getByRole('button',{name:'应用'}));await waitFor(()=>expect(calls.requests.at(-1)?.searchParams.get('createdFrom')).toBe(new Date(2026,9,31).toISOString()));
 expect(calls.requests.at(-1)?.searchParams.get('createdBefore')).toBe(new Date(2026,10,2).toISOString());expect(calls.requests.at(-1)?.searchParams.get('offset')).toBe('0');
 fireEvent.click(screen.getByRole('button',{name:'作品日期：10/31 — 11/01'}));fireEvent.click(screen.getByRole('radio',{name:'今天'}));fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(screen.getByRole('button',{name:'作品日期：10/31 — 11/01'})).toBeInTheDocument();
});
it('management selection includes images and videos above seven, clears on paging and preserves ordered reference picks',async()=>{
 const items=Array.from({length:10},(_,i)=>row('作品'+i,i===9?'video':'image'));api(items,undefined,40);const video=vi.fn();render(<WorkbenchLibrary {...props} onVideo={video}/>);await screen.findByText('作品0');
 fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[1]);fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[0]);
 fireEvent.click(screen.getByRole('button',{name:'多选'}));fireEvent.click(screen.getByRole('button',{name:'全选当前页'}));expect(screen.getByText('已选 10 项')).toBeInTheDocument();expect(selected('作品9')).toBeChecked();
 fireEvent.click(screen.getByRole('button',{name:'下一页'}));await waitFor(()=>expect(screen.getByText('已选 0 项')).toBeInTheDocument());fireEvent.click(screen.getByRole('button',{name:'退出多选'}));fireEvent.click(screen.getByRole('button',{name:'带入多图参考草稿'}));expect(video.mock.calls[0][0].map((a:{assetId:string})=>a.assetId)).toEqual(['作品1','作品0']);
});
it('batch button performs whole-task mixed moves once and reports same-target skips',async()=>{
 const calls=api([row('图片'),row('视频','video'),row('已在目标','image',other)]);render(<WorkbenchLibrary {...props}/>);await screen.findByText('图片');fireEvent.click(screen.getByRole('button',{name:'多选'}));fireEvent.click(screen.getByRole('button',{name:'全选当前页'}));fireEvent.click(screen.getByRole('button',{name:'移动到分组'}));fireEvent.change(screen.getByLabelText('目标剧本'),{target:{value:other}});fireEvent.click(screen.getByRole('button',{name:'确认移动 3 项'}));
 await screen.findByText('已处理 3 / 3 项：成功 2，失败 0，跳过 1');expect(calls.posts.map(p=>p.id)).toEqual(['图片','视频']);expect(calls.posts.every(p=>p.body.groupId===other)).toBe(true);expect(screen.getByText('已选 0 项')).toBeInTheDocument();
});
it('batch drag carries only checked tasks; unknown receipt retries its original requestId and failed items stay selected',async()=>{
 const calls=api([row('回执'),row('成功','video'),row('未选')],async(task,body,call)=>{if(call===1)throw Error('synthetic network');return Response.json({task:{...task,groupId:body.groupId,groupRevision:2,revision:2},movedFiles:1});});
 render(<WorkbenchLibrary {...props}/>);await screen.findByText('回执');fireEvent.click(screen.getByRole('button',{name:'多选'}));fireEvent.click(selected('回执'));fireEvent.click(selected('成功'));
 const data=new Map<string,string>(),transfer={setData:(k:string,v:string)=>data.set(k,v),getData:(k:string)=>data.get(k)||'',effectAllowed:'',dropEffect:''},card=screen.getByRole('button',{name:'预览作品：回执'}).closest('article')!;
 fireEvent.dragStart(card,{dataTransfer:transfer});const target=screen.getByRole('button',{name:'海边短片'});fireEvent.dragOver(target,{dataTransfer:transfer});expect(target).toHaveTextContent('移入 2 项');fireEvent.drop(target,{dataTransfer:transfer});
 await screen.findByRole('button',{name:'核对原移动请求'});expect(calls.posts.map(p=>p.id)).toEqual(['回执','成功']);expect(selected('回执')).toBeChecked();expect(selected('成功')).not.toBeChecked();
 fireEvent.click(screen.getByRole('button',{name:'核对原移动请求'}));await screen.findByText('已处理 1 / 1 项：成功 1，失败 0，跳过 0');expect(calls.posts[2].body.requestId).toBe(calls.posts[0].body.requestId);expect(calls.posts[2].body.groupId).toBe(other);
});
it('partial definitive failure leaves the failed item selected and does not roll back the successful task',async()=>{
 api([row('保留'),row('移动')],async(task,body)=>task.localTaskId==='保留'?Response.json({code:'GROUP_RECOVERY_REQUIRED'},{status:409}):Response.json({task:{...task,groupId:body.groupId,groupRevision:2,revision:2},movedFiles:1}));
 render(<WorkbenchLibrary {...props}/>);await screen.findByText('保留');fireEvent.click(screen.getByRole('button',{name:'多选'}));fireEvent.click(screen.getByRole('button',{name:'全选当前页'}));fireEvent.click(screen.getByRole('button',{name:'移动到分组'}));fireEvent.click(screen.getByRole('button',{name:'确认移动 2 项'}));
 await screen.findByText('已处理 2 / 2 项：成功 1，失败 1，跳过 0');expect(selected('保留')).toBeChecked();expect(selected('移动')).not.toBeChecked();expect(screen.queryByRole('button',{name:'核对原移动请求'})).not.toBeInTheDocument();
});
it('busy batch locks its range and duplicate submit; unmount stops dispatching later tasks',async()=>{
 const pending=deferred<Response>(),calls=api([row('先'),row('后')],()=>pending.promise);const view=render(<WorkbenchLibrary {...props}/>);await screen.findByText('先');fireEvent.click(screen.getByRole('button',{name:'多选'}));fireEvent.click(screen.getByRole('button',{name:'全选当前页'}));fireEvent.click(screen.getByRole('button',{name:'移动到分组'}));const confirm=screen.getByRole('button',{name:'确认移动 2 项'});fireEvent.click(confirm);fireEvent.click(confirm);
 await waitFor(()=>expect(calls.posts).toHaveLength(1));expect(screen.getByText('正在移动：已处理 0 / 2 项')).toBeInTheDocument();expect(screen.getByLabelText('搜索提示词或模型')).toBeDisabled();expect(screen.getByRole('button',{name:'退出多选'})).toBeDisabled();view.unmount();await act(async()=>pending.resolve(Response.json({task:{...row('先'),groupId:other,groupRevision:2,revision:2},movedFiles:1})));expect(calls.posts).toHaveLength(1);
});
it('batch helper reports cancelled remainder without sending or inventing success',async()=>{
 const tasks=[row('a'),row('b')];api(tasks);let cancelled=false;const result=await moveLibraryTasks(tasks,other,{cancelled:()=>cancelled,progress:()=>{cancelled=true;}});expect(result.items.map(i=>i.status)).toEqual(['succeeded','not_started']);expect(result.succeeded).toBe(1);
});
it('today filter refreshes across local midnight',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,31,23,59,59,500));const calls=api([row('跨日')]);render(<WorkbenchLibrary {...props}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1);});fireEvent.click(screen.getByRole('button',{name:'作品日期：全部日期'}));fireEvent.click(screen.getByRole('radio',{name:'今天'}));fireEvent.click(screen.getByRole('button',{name:'应用'}));await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
 expect(calls.requests.at(-1)?.searchParams.get('createdFrom')).toBe(new Date(2026,9,31).toISOString());await act(async()=>{await vi.advanceTimersByTimeAsync(700);});expect(calls.requests.at(-1)?.searchParams.get('createdFrom')).toBe(new Date(2026,10,1).toISOString());
});
it('hover waits 250ms, is muted and looping, and quick pass never plays',async()=>{
 vi.useFakeTimers();render(<LibraryVideoPreview src="/synthetic/video"/>);const root=document.querySelector('.wb-hover-video')!,player=root.querySelector('video')!;
 fireEvent.mouseEnter(root);await act(async()=>vi.advanceTimersByTimeAsync(200));fireEvent.mouseLeave(root);await act(async()=>vi.advanceTimersByTimeAsync(100));expect(player.play).not.toHaveBeenCalled();
 fireEvent.mouseEnter(root);await act(async()=>vi.advanceTimersByTimeAsync(250));expect(player.play).toHaveBeenCalledTimes(1);expect(player.muted).toBe(true);expect(player.loop).toBe(true);expect(root).toHaveAttribute('data-hover-playing','true');fireEvent.mouseLeave(root);expect(root).not.toHaveAttribute('data-hover-playing');
});
it('claiming another cover pauses previous playback and stale same-video play resolution cannot pause a new claim',async()=>{
 vi.useFakeTimers();const first=deferred<void>(),second=deferred<void>();vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>second.promise);
 render(<><LibraryVideoPreview src="/synthetic/a"/><LibraryVideoPreview src="/synthetic/b"/></>);const roots=document.querySelectorAll('.wb-hover-video'),a=roots[0],player=a.querySelector('video')!;
 fireEvent.mouseEnter(a);await act(async()=>vi.advanceTimersByTimeAsync(250));fireEvent.mouseLeave(a);fireEvent.mouseEnter(a);await act(async()=>vi.advanceTimersByTimeAsync(250));await act(async()=>second.resolve());const before=vi.mocked(player.pause).mock.calls.length;await act(async()=>first.resolve());expect(vi.mocked(player.pause).mock.calls.length).toBe(before);expect(a).toHaveAttribute('data-hover-playing','true');
 fireEvent.mouseEnter(roots[1]);await act(async()=>vi.advanceTimersByTimeAsync(250));expect(a).not.toHaveAttribute('data-hover-playing');expect(roots[1]).toHaveAttribute('data-hover-playing','true');
});
it('blur, drag stop, management disable and offscreen visibility detach the source; errors remain explicit',async()=>{
 vi.useFakeTimers();let intersect:IntersectionObserverCallback|undefined;vi.stubGlobal('IntersectionObserver',class{constructor(fn:IntersectionObserverCallback){intersect=fn;}observe(){}disconnect(){}});
 const view=render(<LibraryVideoPreview src="/synthetic/stop"/>);const root=document.querySelector('.wb-hover-video')!,player=root.querySelector('video')!;expect(player).not.toHaveAttribute('src');act(()=>intersect?.([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver));fireEvent.mouseEnter(root);await act(async()=>vi.advanceTimersByTimeAsync(250));
 fireEvent(window,new Event('blur'));expect(player).not.toHaveAttribute('src');const playCount=vi.mocked(player.play).mock.calls.length;fireEvent.mouseEnter(root);await act(async()=>vi.advanceTimersByTimeAsync(300));expect(vi.mocked(player.play).mock.calls.length).toBe(playCount);fireEvent(window,new Event('focus'));expect(player).toHaveAttribute('src','/synthetic/stop');act(()=>stopLibraryPreviews());expect(player).not.toHaveAttribute('src');
 fireEvent(window,new Event('focus'));act(()=>intersect?.([{isIntersecting:false} as IntersectionObserverEntry],{} as IntersectionObserver));expect(player).not.toHaveAttribute('src');view.rerender(<LibraryVideoPreview src="/synthetic/stop" disabled/>);expect(player).not.toHaveAttribute('src');
 view.rerender(<LibraryVideoPreview src="/synthetic/error"/>);act(()=>intersect?.([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver));fireEvent.error(player);expect(screen.getByRole('status')).toHaveTextContent('暂无法播放');
});


it('a running batch crossing midnight applies the new today boundary as soon as it finishes',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,31,23,59,59,500));const pending=deferred<Response>(),calls=api([row('跨日先'),row('跨日后')],async(task,body,call)=>call===1?pending.promise:Response.json({task:{...task,groupId:body.groupId,groupRevision:2,revision:2},movedFiles:1}));
 render(<WorkbenchLibrary {...props}/>);await act(async()=>vi.advanceTimersByTimeAsync(1));fireEvent.click(screen.getByRole('button',{name:'作品日期：全部日期'}));fireEvent.click(screen.getByRole('radio',{name:'今天'}));fireEvent.click(screen.getByRole('button',{name:'应用'}));await act(async()=>vi.advanceTimersByTimeAsync(1));
 fireEvent.click(screen.getByRole('button',{name:'多选'}));fireEvent.click(screen.getByRole('button',{name:'全选当前页'}));fireEvent.click(screen.getByRole('button',{name:'移动到分组'}));fireEvent.click(screen.getByRole('button',{name:'确认移动 2 项'}));await act(async()=>vi.advanceTimersByTimeAsync(1));expect(screen.getByText('正在移动：已处理 0 / 2 项')).toBeInTheDocument();
 await act(async()=>vi.advanceTimersByTimeAsync(700));expect(calls.requests.filter(r=>r.searchParams.has('createdFrom')).at(-1)?.searchParams.get('createdFrom')).toBe(new Date(2026,9,31).toISOString());
 await act(async()=>{pending.resolve(Response.json({task:{...row('跨日先'),groupId:other,groupRevision:2,revision:2},movedFiles:1}));await vi.advanceTimersByTimeAsync(1);});
 expect(calls.requests.at(-1)?.searchParams.get('createdFrom')).toBe(new Date(2026,10,1).toISOString());expect(screen.getByText('已选 0 项')).toBeInTheDocument();
});
it('automatic page correction after a partial move retains the failed item and permits a new retry',async()=>{
 let corrected=false,failedCalls=0;const posts:Array<{id:string;requestId:string}>=[],queries:number[]=[];vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{
  const url=new URL(route,'http://synthetic.invalid');
  if(init?.method==='POST'){const id=decodeURIComponent(url.pathname.split('/').at(-2)!),body=JSON.parse(String(init.body));posts.push({id,requestId:body.requestId});if(id==='留在原组'&&failedCalls++===0)return Response.json({code:'FILE_BUSY'},{status:409});corrected=true;return Response.json({task:{...row(id),groupId:other,groupRevision:2,revision:2},movedFiles:1});}
  const offset=Number(url.searchParams.get('offset'));queries.push(offset);return Response.json({items:corrected&&offset===24?[]:[row('留在原组'),row('成功项')],total:corrected?24:26,unfilteredTotal:26});
 }));
 render(<WorkbenchLibrary {...props}/>);await screen.findByText('留在原组');fireEvent.click(screen.getByRole('button',{name:'下一页'}));await waitFor(()=>expect(queries.at(-1)).toBe(24));await screen.findByText('留在原组');
 fireEvent.click(screen.getByRole('button',{name:'多选'}));fireEvent.click(screen.getByRole('button',{name:'全选当前页'}));fireEvent.click(screen.getByRole('button',{name:'移动到分组'}));fireEvent.click(screen.getByRole('button',{name:'确认移动 2 项'}));
 await screen.findByText('已处理 2 / 2 项：成功 1，失败 1，跳过 0');await waitFor(()=>expect(queries.at(-1)).toBe(0));expect(selected('留在原组')).toBeChecked();expect(screen.getByText('已选 1 项')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'移动到分组'}));fireEvent.click(screen.getByRole('button',{name:'确认移动 1 项'}));await screen.findByText('已处理 1 / 1 项：成功 1，失败 0，跳过 0');expect(posts.filter(p=>p.id==='留在原组')).toHaveLength(2);expect(posts[2].requestId).not.toBe(posts[0].requestId);
});


it('date labels retain the year for cross-year and historical ranges',()=>{expect(libraryDateLabel({mode:'custom',start:'2025-10-31',end:'2026-10-31'})).toBe('2025/10/31 — 2026/10/31');expect(libraryDateLabel({mode:'custom',start:'2024-01-01',end:'2024-01-02'})).toBe('2024/01/01 — 2024/01/02');});
