'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { groupOperationPending, unconfirmedGroupInput, watchCompletedGroupMoves, watchGroupOperations } from '@/lib/workbench-group-client';
import { FolderHeart, MoreHorizontal } from 'lucide-react';
import { getLocalHistory, HistoryTask, localErrorMessage, removeHistoryTask, type WorkbenchGroup } from '@/lib/workbench-client';
import { AssetSummary } from '@/lib/workbench-task-client';
import { MAX_VIDEO_REFERENCE_ASSETS } from '@/lib/reference-policy';
import { taskExecutionActive } from '@/lib/workbench-generation';
import { moveLibraryTasks, type LibraryMoveBatch } from '@/lib/library-group-batch';
import { libraryDateBounds, localDay, type LibraryDateSelection } from '@/lib/library-date-filter';
import { WorkbenchDialog } from './WorkbenchResults';
import { MediaTaskCard } from './MediaTaskCard';
import { DEFAULT_GROUP } from '@/hooks/useWorkbenchGroups';
import { WorkbenchLibraryPreview } from './WorkbenchLibraryPreview';
import { LibraryDateFilter } from './LibraryDateFilter';
import { stopLibraryPreviews } from './LibraryVideoPreview';

export function WorkbenchLibrary({ revision, onDetails, onVideo, onImage, onImageReference, picking, groups = [DEFAULT_GROUP], onManageGroups, onRegroup, onGroupsChanged, groupsReady=true }: { revision: number; onDetails: (task: HistoryTask) => void; onVideo: (assets: AssetSummary[]) => void; onImage: () => void; onImageReference?: (asset: AssetSummary) => void; picking?: boolean; groups?: WorkbenchGroup[]; onManageGroups?: () => void; onRegroup?: (task: HistoryTask) => void; onGroupsChanged?: () => void; groupsReady?: boolean }) {
  const [result,setResult] = useState<Awaited<ReturnType<typeof getLocalHistory>> | null>(null), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [kind,setKind] = useState(picking ? 'image' : ''), [search,setSearch] = useState(''), [groupId,setGroupId] = useState(''), [offset,setOffset] = useState(0), [reload,setReload] = useState(0), [loading,setLoading] = useState(false);
  const [selection,setSelection] = useState<AssetSummary[]>([]), [deleting,setDeleting] = useState<HistoryTask | null>(null), [deleteOutputs,setDeleteOutputs] = useState(false), [busy,setBusy] = useState(false);
  const [date,setDate]=useState<LibraryDateSelection>({mode:'all',start:'',end:''}),[today,setToday]=useState(localDay);
  const [managing,setManaging]=useState(false),[selectedIds,setSelectedIds]=useState<string[]>([]),[batchBusy,setBatchBusy]=useState(false),[batch,setBatch]=useState<LibraryMoveBatch|null>(null),[receipt,setReceipt]=useState<{tasks:HistoryTask[];groupId:string}|null>(null);
  const [chooseTarget,setChooseTarget]=useState(false),[targetId,setTargetId]=useState(''),[preview,setPreview]=useState<HistoryTask|null>(null);
  const [dragging,setDragging]=useState<HistoryTask[]>([]),[dropTarget,setDropTarget]=useState(''),[,renderMoves]=useState(0);
  const dragged=useRef<HistoryTask[]>([]),mounted=useRef(true),batchRunning=useRef(false),deletion=useRef(false),sequence=useRef(0),limit=24;
  const bounds=useMemo(()=>libraryDateBounds(date),[date,today]);
  const queryKey=JSON.stringify([groupId,kind,search,offset,bounds.createdFrom,bounds.createdBefore]);
  const [resultKey,setResultKey]=useState('');
  const visibleResult=resultKey===queryKey?result:null;
  function resetRange(){stopLibraryPreviews();setSelectedIds([]);dragged.current=[];setDragging([]);setDropTarget('');setOffset(0);}
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;stopLibraryPreviews();};},[]);
  useEffect(()=>watchGroupOperations(()=>renderMoves(value=>value+1)),[]);
  useEffect(()=>{if(groupsReady&&groupId&&!groups.some(group=>group.groupId===groupId)&&!batchRunning.current){setGroupId('');resetRange();}},[groupsReady,groups,groupId]);
  useEffect(()=>{
    if(date.mode!=='today')return;
    let timer:ReturnType<typeof setTimeout>;
    const tick=()=>{if(batchRunning.current){timer=setTimeout(tick,1000);return;}setToday(localDay());resetRange();schedule();};
    const schedule=()=>{const now=new Date(),next=new Date(now);next.setHours(24,0,0,0);timer=setTimeout(tick,Math.max(100,next.getTime()-now.getTime()+20));};
    schedule();return()=>clearTimeout(timer);
  },[date.mode]);
  useEffect(()=>watchCompletedGroupMoves((before,after)=>{
    const replacements=new Map(before.outputAssets?.map((asset,index)=>[asset.assetId,after.outputAssets?.[index]]));
    setSelection(previous=>previous.flatMap(asset=>replacements.has(asset.assetId)?replacements.get(asset.assetId)?[replacements.get(asset.assetId)!]:[]:[asset]));
    setPreview(previous=>previous?.localTaskId===after.localTaskId?after:previous);
    if(!batchRunning.current)setReload(value=>value+1);
  }),[]);
  const hasActiveTasks=result?.items.some(task=>taskExecutionActive(task));
  useEffect(()=>{if(!hasActiveTasks)return;const timer=setInterval(()=>{if(!batchRunning.current)setReload(value=>value+1);},2000);return()=>clearInterval(timer);},[hasActiveTasks]);
  useEffect(()=>{
    let active=true;const ticket=++sequence.current;stopLibraryPreviews();
    void Promise.resolve().then(async()=>{if(!active)return;setLoading(true);try{
      const value=await getLocalHistory({limit,offset,kind,search,groupId,scope:'library',...bounds});
      if(active&&ticket===sequence.current){setResult(value);setResultKey(queryKey);setError('');if(offset&&offset>=value.total){setOffset(Math.max(0,Math.floor((value.total-1)/limit)*limit));}}
    }catch(error){if(active&&ticket===sequence.current)setError(localErrorMessage(error));}finally{if(active&&ticket===sequence.current)setLoading(false);}});
    return()=>{active=false;};
  },[kind,search,groupId,offset,reload,revision,queryKey,bounds]);
  const toggle=(asset:AssetSummary)=>setSelection(previous=>previous.some(item=>item.assetId===asset.assetId)?previous.filter(item=>item.assetId!==asset.assetId):previous.length<MAX_VIDEO_REFERENCE_ASSETS?[...previous,asset]:previous);
  function moveSelection(index:number,direction:number){setSelection(previous=>{const next=index+direction;if(next<0||next>=previous.length)return previous;const values=[...previous];[values[index],values[next]]=[values[next],values[index]];return values;});}
  const sourceBlocked=(task:HistoryTask)=>taskExecutionActive(task)||groupOperationPending('task:'+task.localTaskId)||groups.some(group=>group.groupId===task.groupId&&group.recoveryRequired);
  const chosenTasks=selectedIds.map(id=>visibleResult?.items.find(task=>task.localTaskId===id)||batch?.items.find(item=>item.task.localTaskId===id&&['failed','unknown','not_started'].includes(item.status))?.task).filter((task):task is HistoryTask=>Boolean(task));
  const accepting=(target:string,tasks:HistoryTask[])=>!batchRunning.current&&tasks.length>0&&groups.some(group=>group.groupId===target&&!group.archived&&!group.recoveryRequired)&&tasks.some(task=>task.groupId!==target)&&tasks.every(task=>!sourceBlocked(task));
  async function move(tasks:HistoryTask[],target:string,reconciling=false){
    if(batchRunning.current||!tasks.length||(!reconciling&&!accepting(target,tasks)))return;
    const conflict=tasks.find(task=>{const previous=unconfirmedGroupInput('task:'+task.localTaskId) as {groupId?:string}|undefined;return previous&&previous.groupId!==target;});
    if(conflict){setNotice('该作品有尚未确认的移动，请先从修改分组入口核对原请求。');return;}
    const frozen=tasks.map(task=>({...task}));setBatch({groupId:target,items:[],total:frozen.length,succeeded:0,failed:0,unknown:0,skipped:0});batchRunning.current=true;setBatchBusy(true);setChooseTarget(false);setNotice('');stopLibraryPreviews();dragged.current=[];setDragging([]);setDropTarget('');
    // Let React detach video sources before the first Windows filesystem operation.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
    try{
      const result=await moveLibraryTasks(frozen,target,{cancelled:()=>!mounted.current,progress:value=>{if(mounted.current)setBatch(value);}});
      if(!mounted.current)return;
      setBatch(result);setSelectedIds(result.items.filter(item=>['failed','unknown','not_started'].includes(item.status)).map(item=>item.task.localTaskId));
      const unknown=result.items.filter(item=>item.status==='unknown').map(item=>item.task);
      setReceipt(unknown.length?{tasks:unknown,groupId:target}:null);if(date.mode==='today'&&today!==localDay()){setToday(localDay());resetRange();}setReload(value=>value+1);onGroupsChanged?.();
    }finally{batchRunning.current=false;if(mounted.current)setBatchBusy(false);}
  }
  function startDrag(task:HistoryTask,event:React.DragEvent<HTMLElement>){
    if(batchRunning.current||sourceBlocked(task)){event.preventDefault();return;}
    const tasks=managing&&selectedIds.includes(task.localTaskId)?chosenTasks:[task];
    if(tasks.some(sourceBlocked)){event.preventDefault();return;}
    stopLibraryPreviews();dragged.current=tasks.map(item=>({...item}));setDragging(tasks);
    event.dataTransfer.setData('application/x-nova-task',task.localTaskId);event.dataTransfer.setData('application/x-nova-tasks',JSON.stringify(tasks.map(item=>item.localTaskId)));event.dataTransfer.effectAllowed='move';
    if(tasks.length>1&&event.dataTransfer.setDragImage){const ghost=document.createElement('div');ghost.className='wb-library-drag-ghost';const icon=document.createElement('span');icon.className='wb-library-drag-covers';tasks.slice(0,3).forEach((item,index)=>{const asset=item.outputAssets?.[0],card=[...document.querySelectorAll<HTMLElement>('[data-task-id]')].find(element=>element.dataset.taskId===item.localTaskId),poster=asset?.kind==='image'?asset.previewUrl:card?.querySelector('video')?.poster;const cover=document.createElement(poster?'img':'span');if(poster)(cover as HTMLImageElement).src=poster;else cover.textContent='▶';cover.style.transform='translate('+index*7+'px,'+index*4+'px)';icon.append(cover);});const count=document.createElement('strong');count.textContent=String(tasks.length);const text=document.createElement('span');text.textContent=tasks.length+' 项作品';ghost.append(icon,count,text);document.body.append(ghost);event.dataTransfer.setDragImage(ghost,22,22);setTimeout(()=>ghost.remove(),0);}
  }
  function endDrag(){dragged.current=[];setDragging([]);setDropTarget('');}
  function openPreview(task:HistoryTask){if(batchRunning.current||managing)return;stopLibraryPreviews();setPreview(task);}
  async function remove(){
    if(!deleting||deletion.current||batchRunning.current||groupOperationPending('task:'+deleting.localTaskId))return;
    deletion.current=true;setBusy(true);setNotice('');stopLibraryPreviews();
    try{const value=await removeHistoryTask(deleting.localTaskId,deleteOutputs);setNotice(`记录已移出作品库。${deleteOutputs?`已删除 ${value.deletedAssets} 个独占生成文件，保留 ${value.retainedAssets} 个共享、输入或未能删除的文件。`:'所有文件仍保留。'}`);setDeleting(null);setSelection([]);setSelectedIds([]);setReload(value=>value+1);}
    catch(error){setNotice(localErrorMessage(error));}finally{deletion.current=false;setBusy(false);}
  }
  function openBatchTarget(){if(!chosenTasks.length||batchRunning.current||receipt)return;setTargetId(groups.find(group=>!group.archived&&!group.recoveryRequired&&chosenTasks.some(task=>task.groupId!==group.groupId))?.groupId||'');setChooseTarget(true);}
  const filtered=Boolean(search||kind||groupId||date.mode!=='all');
  return <section className="wb-panel wb-library">
    <div className="wb-section-heading"><h2>本机作品库</h2><button type="button" disabled={batchBusy} onClick={()=>{setSelectedIds([]);setReload(value=>value+1);}}>刷新作品库</button></div>
    <p className="wb-help">完整保存的图片与视频在这里整理。未完成与失败记录请在生成页查看全部任务。{visibleResult&&`共 ${visibleResult.unfilteredTotal??visibleResult.total} 条作品记录。`}</p>
    <div className="wb-library-layout" data-dragging-task={dragging[0]?.localTaskId} data-dragging-count={dragging.length||undefined}>
      <nav className="wb-group-sidebar" aria-label="剧本分组">
        <button type="button" disabled={batchBusy} aria-current={!groupId?'page':undefined} onClick={()=>{setGroupId('');resetRange();}}>全部作品</button>
        {groups.map(group=><button type="button" key={group.groupId} disabled={batchBusy} data-drop-active={dropTarget===group.groupId||undefined} data-drop-disabled={group.archived||group.recoveryRequired||undefined} title={group.recoveryRequired?'该剧本的文件整理需要恢复':group.archived?'已归档剧本不能接收作品':undefined}
          onDragOver={event=>{if(accepting(group.groupId,dragged.current)){event.preventDefault();event.dataTransfer.dropEffect='move';setDropTarget(group.groupId);}}}
          onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDropTarget('');}}
          onDrop={event=>{event.preventDefault();const tasks=dragged.current;const payload=event.dataTransfer.getData('application/x-nova-tasks');const valid=payload?payload===JSON.stringify(tasks.map(task=>task.localTaskId)):tasks.length===1&&event.dataTransfer.getData('application/x-nova-task')===tasks[0].localTaskId;endDrag();if(valid&&accepting(group.groupId,tasks))void move(tasks,group.groupId);}}
          aria-current={groupId===group.groupId?'page':undefined} onClick={()=>{setGroupId(group.groupId);resetRange();}}>
          <span>{group.name}{group.archived?'（已归档）':''}{dropTarget===group.groupId&&dragging.length>1&&<em>移入 {dragging.length} 项</em>}</span>{typeof group.workCount==='number'&&<small>{group.workCount}</small>}
        </button>)}
        {onManageGroups&&<button type="button" disabled={batchBusy} onClick={()=>{stopLibraryPreviews();onManageGroups();}}>新建 / 管理分组</button>}
      </nav>
      <div className="wb-library-content">
        <div className="wb-library-filters wb-library-enhanced-filters">
          <label>搜索提示词或模型<input type="search" disabled={batchBusy} value={search} onChange={event=>{setSearch(event.target.value);resetRange();}} placeholder="输入关键词"/></label>
          <label>作品类型<select disabled={batchBusy} value={kind} onChange={event=>{setKind(event.target.value);resetRange();}}><option value="">全部类型</option><option value="image">图片</option><option value="video">视频</option></select></label>
          <LibraryDateFilter disabled={batchBusy} value={date} onChange={value=>{setDate(value);setToday(localDay());resetRange();}}/>
          <button type="button" className="wb-library-mode" disabled={batchBusy} aria-pressed={managing} onClick={()=>{stopLibraryPreviews();setManaging(!managing);setSelectedIds([]);endDrag();}}>{managing?'退出多选':'多选'}</button>
        </div>
        {managing?<div className="wb-library-selection wb-library-batch-toolbar" aria-label="批量整理">
          <strong>已选 {selectedIds.length} 项</strong>
          <button type="button" disabled={batchBusy||loading||!visibleResult} onClick={()=>setSelectedIds((visibleResult?.items||[]).filter(task=>!sourceBlocked(task)).map(task=>task.localTaskId))}>全选当前页</button>
          <button type="button" disabled={batchBusy||!selectedIds.length} onClick={()=>setSelectedIds([])}>清空</button>
          <button type="button" className="wb-primary" disabled={batchBusy||!chosenTasks.length||Boolean(receipt)} onClick={openBatchTarget}>移动到分组</button>
        </div>:<><div className="wb-library-selection"><p>{selection.length?`已按顺序选择 ${selection.length} 张：${selection.map((asset,index)=>`${index+1}. ${asset.displayName}`).join('，')}`:`按选择顺序带入 PNG / JPEG 图片，本应用一次最多添加 ${MAX_VIDEO_REFERENCE_ASSETS} 张，服务实际支持数量待确认。多图不代表首尾帧锁定。`}</p><button type="button" disabled={!selection.length||batchBusy} onClick={()=>onVideo(selection)}>带入{selection.length>=2?'多图参考':'单图视频'}草稿</button>{onImageReference&&<button type="button" disabled={selection.length!==1||batchBusy} onClick={()=>onImageReference(selection[0])}>带入图片编辑草稿</button>}{selection.length>0&&<button type="button" disabled={batchBusy} onClick={()=>setSelection([])}>清除选择</button>}</div>
          {selection.length>0&&<ol className="wb-library-picked" aria-label="已选图片顺序">{selection.map((asset,index)=><li key={asset.assetId}><span>{index+1}. {asset.displayName}</span><button type="button" aria-label={`已选图片 ${index+1} 前移`} disabled={index===0||batchBusy} onClick={()=>moveSelection(index,-1)}>前移</button><button type="button" aria-label={`已选图片 ${index+1} 后移`} disabled={index===selection.length-1||batchBusy} onClick={()=>moveSelection(index,1)}>后移</button><button type="button" aria-label={`移除已选图片 ${index+1}`} disabled={batchBusy} onClick={()=>setSelection(previous=>previous.filter((_,position)=>position!==index))}>移除</button></li>)}</ol>}</>}
        {batch&&<div className="wb-library-batch-result" role="status">
          <span>{batchBusy?`正在移动：已处理 ${batch.items.length} / ${batch.total} 项`:`已处理 ${batch.items.length} / ${batch.total} 项：成功 ${batch.succeeded}，失败 ${batch.failed}，跳过 ${batch.skipped}`}{batch.unknown>0&&`，回执待核对 ${batch.unknown}`}</span>
          {batch.items.filter(item=>item.status==='failed'||item.status==='unknown').map(item=><p key={item.task.localTaskId}>{item.task.prompt||item.task.localTaskId}：{item.status==='unknown'?'移动回执未确认。':''}{item.message}</p>)}
          {receipt&&<button type="button" disabled={batchBusy} onClick={()=>void move(receipt.tasks,receipt.groupId,true)}>核对原移动请求</button>}
        </div>}
        {notice&&<p role="status" className="wb-notice">{notice}</p>}{error&&<p role="alert" className="wb-error">{error}<button type="button" disabled={batchBusy} onClick={()=>setReload(value=>value+1)}>重新读取</button></p>}
        {loading&&<p role="status" className="wb-help">正在读取本机记录…</p>}
        {!visibleResult?<div className="wb-empty">正在读取作品库…</div>:visibleResult.total===0?<div className="wb-empty"><FolderHeart size={40}/><h3>{(visibleResult.unfilteredTotal??visibleResult.total)===0&&!filtered?'作品库还是空的':'没有符合筛选条件的作品'}</h3><p>本地任务与作品不会因关闭应用而清除。</p>{filtered&&<button type="button" disabled={batchBusy} onClick={()=>{setSearch('');setKind('');setGroupId('');setDate({mode:'all',start:'',end:''});resetRange();}}>清除筛选</button>}<button type="button" disabled={batchBusy} onClick={onImage}>准备图片草稿</button></div>:<>
          <div className="wb-library-grid" aria-busy={loading}>{visibleResult.items.map(task=>{
            const asset=task.outputAssets?.[0],selected=selection.findIndex(item=>item.assetId===asset?.assetId),selectable=asset?.kind==='image'&&asset.availability==='available'&&['image/png','image/jpeg'].includes(asset.mimeType);
            return <MediaTaskCard key={task.localTaskId} task={task} variant="library" draggable={!batchBusy&&!sourceBlocked(task)} onDragStart={event=>startDrag(task,event)} onDragEnd={endDrag}
              selection={managing?{checked:selectedIds.includes(task.localTaskId),disabled:batchBusy||sourceBlocked(task),onToggle:()=>{if(!batchRunning.current)setSelectedIds(previous=>previous.includes(task.localTaskId)?previous.filter(id=>id!==task.localTaskId):[...previous,task.localTaskId]);}}:undefined}
              hoverDisabled={managing||batchBusy||dragging.length>0||Boolean(preview)||Boolean(deleting)||chooseTarget}
              onPreview={()=>openPreview(task)} onDetails={()=>{if(!batchBusy){stopLibraryPreviews();onDetails(task);}}}
              actions={!managing&&selectable&&<button type="button" aria-pressed={selected>=0} disabled={batchBusy||(selected<0&&selection.length>=MAX_VIDEO_REFERENCE_ASSETS)} onClick={()=>toggle(asset)}>{selected>=0?`已选 ${selected+1} · 取消`:'选择图片'}</button>}
              menu={<details className="wb-card-menu"><summary aria-label="更多作品操作"><MoreHorizontal size={16}/></summary><div>{onRegroup&&<button type="button" disabled={batchBusy||taskExecutionActive(task)||groupOperationPending('task:'+task.localTaskId)} onClick={()=>{stopLibraryPreviews();onRegroup(task);}}>修改分组</button>}<button type="button" disabled={batchBusy||taskExecutionActive(task)||groupOperationPending('task:'+task.localTaskId)} title={taskExecutionActive(task)?'任务仍在本地执行，请先取消并等待服务确认。':undefined} onClick={()=>{stopLibraryPreviews();setDeleting(task);setDeleteOutputs(false);}}>从作品库隐藏</button></div></details>}/>;
          })}</div>
          <div className="wb-pagination"><button type="button" disabled={offset===0||loading||batchBusy} onClick={()=>{stopLibraryPreviews();setSelectedIds([]);setOffset(value=>Math.max(0,value-limit));}}>上一页</button><span>第 {Math.floor(offset/limit)+1} / {Math.max(1,Math.ceil(visibleResult.total/limit))} 页 · {visibleResult.total} 条</span><button type="button" disabled={offset+limit>=visibleResult.total||loading||batchBusy} onClick={()=>{stopLibraryPreviews();setSelectedIds([]);setOffset(value=>value+limit);}}>下一页</button></div>
        </>}
      </div>
    </div>
    {preview&&<WorkbenchLibraryPreview key={preview.localTaskId+':'+preview.outputAssets?.[0]?.assetId} task={preview} onClose={()=>setPreview(null)}/>}
    {chooseTarget&&<WorkbenchDialog title="批量修改分组" onClose={()=>{if(!batchBusy)setChooseTarget(false);}}><p>将所选 {chosenTasks.length} 项作品的全部输出移动到目标分组。</p><label>目标剧本<select value={targetId} disabled={batchBusy} onChange={event=>setTargetId(event.target.value)}><option value="">请选择分组</option>{groups.map(group=><option key={group.groupId} value={group.groupId} disabled={group.archived||group.recoveryRequired}>{group.name}{group.archived?'（已归档）':group.recoveryRequired?'（待恢复）':''}</option>)}</select></label><div className="wb-actions"><button type="button" onClick={()=>setChooseTarget(false)}>取消</button><button type="button" className="wb-primary" disabled={!targetId||!accepting(targetId,chosenTasks)} onClick={()=>void move(chosenTasks,targetId)}>确认移动 {chosenTasks.length} 项</button></div></WorkbenchDialog>}
    {deleting&&<WorkbenchDialog title="移除作品记录" onClose={()=>{if(!busy)setDeleting(null);}}><p>默认只从作品库移除记录，保留所有文件。任务去重事实仍保留。</p><p className="wb-help wb-prompt">{deleting.prompt}</p><label className="wb-checkbox"><input type="checkbox" checked={deleteOutputs} onChange={event=>setDeleteOutputs(event.target.checked)}/>同时删除该任务独占的应用生成输出文件</label><p className="wb-warning">共享输出、其他任务输入、草稿引用及用户导入源文件均保留。文件删除不可撤销；执行时会再次检查引用。</p><div className="wb-actions"><button type="button" disabled={busy} onClick={()=>setDeleting(null)}>保留记录</button><button type="button" disabled={busy} onClick={()=>void remove()}>确认移除记录{deleteOutputs?'并清理独占输出':''}</button></div></WorkbenchDialog>}
  </section>;
}
