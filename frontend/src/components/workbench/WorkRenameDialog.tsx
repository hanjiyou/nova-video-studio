'use client';
import { useEffect, useRef, useState } from 'react';
import { groupOperationPending, groupReceiptUnknown, renameTaskWork, unconfirmedGroupInput, watchGroupOperations, type WorkNameIntent } from '@/lib/workbench-group-client';
import { currentTask, watchTaskState } from '@/lib/workbench-task-state';
import { workNameError, workNameLength, workTitle } from '@/lib/workbench-names';
import { taskExecutionActive } from '@/lib/workbench-generation';
import { getHistoryTask, localErrorMessage, type HistoryTask } from '@/lib/workbench-client';
import { WorkbenchDialog } from './WorkbenchResults';

export function WorkRenameDialog({task:initial,onClose,onRenamed}: {task:HistoryTask;onClose:()=>void;onRenamed:(task:HistoryTask,cleanupPending?:boolean)=>void}) {
  const key='task:'+initial.localTaskId;
  const saved=unconfirmedGroupInput(key) as WorkNameIntent | undefined;
  const [name,setName]=useState(saved?.kind==='work-name'?saved.workName:initial.workName || ''),[notice,setNotice]=useState(''),[,render]=useState(0),[saving,setSaving]=useState(false),[conflict,setConflict]=useState(false),[reloading,setReloading]=useState(false);
  const running=useRef(false),field=useRef<HTMLInputElement>(null);
  useEffect(()=>{field.current?.focus();field.current?.select();const update=()=>render(value=>value+1),moves=watchGroupOperations(update),tasks=watchTaskState(update);return()=>{moves();tasks();};},[]);
  const task=currentTask(initial),busy=saving||reloading||groupOperationPending(key),active=taskExecutionActive(task),retained=unconfirmedGroupInput(key) as WorkNameIntent | undefined;
  const otherOperation=Boolean(retained&&retained.kind!=='work-name'),validation=workNameError(name);
  async function save(){
    if(running.current||busy||active||otherOperation||validation||conflict)return;
    running.current=true;setSaving(true);setNotice('');
    try{const result=await renameTaskWork(task,name);onRenamed(result.task,result.cleanupPending);onClose();}
    catch(error){if(error instanceof Error&&error.message==='WORK_NAME_REVISION_CONFLICT')setConflict(true);setNotice(groupReceiptUnknown(error)?'改名回执未确认，已保留本次名称。请点击“核对原改名请求”，不会重新生成作品。'+localErrorMessage(error):localErrorMessage(error));}
    finally{running.current=false;setSaving(false);}
  }
  async function reload(){if(busy)return;setReloading(true);try{await getHistoryTask(task.localTaskId);setConflict(false);setNotice('已读取最新作品信息，当前输入仍保留。请核对后再次保存。');}catch(error){setNotice(localErrorMessage(error));}finally{setReloading(false);}}
  return <WorkbenchDialog title="重命名作品" onClose={()=>{if(!running.current&&!busy)onClose();}}><div className="wb-work-rename">
    <div className="wb-work-rename-summary">{task.outputAssets?.[0]?.kind==='image'&&task.outputAssets[0].availability==='available'&&<img src={task.outputAssets[0].previewUrl} alt="待重命名作品"/>}<div><strong>{workTitle(task)}</strong><p className="wb-help">{task.groupName || '未分组'} · {new Date(task.createdAt).toLocaleString('zh-CN')}</p></div></div>
    <form onSubmit={event=>{event.preventDefault();void save();}}><label>作品名称<input ref={field} value={name} disabled={busy||active||Boolean(retained)} aria-invalid={Boolean(validation)} aria-describedby="wb-rename-name-help" placeholder="输入名称，留空恢复提示词标题" onChange={event=>setName(event.target.value)}/></label><div className="wb-work-name-hint"><p id="wb-rename-name-help" className="wb-help">使用简短名称，方便区分镜头和不同版本。</p><span>{workNameLength(name)}/60</span></div>
    <p className="wb-help">保存后，任务记录、作品库和该作品的本机文件名会同步更新。留空后使用提示词命名；同名作品会自动区分。</p>
    {active&&<p className="wb-warning">任务仍在生成、下载或写入文件，请等待结束后再改名。</p>}{otherOperation&&<p className="wb-warning">该作品有尚未核对的文件整理，请先核对原整理请求。</p>}
    {(validation||notice)&&<p role="alert" className="wb-error">{validation||notice}</p>}
    {conflict&&<button type="button" disabled={busy} onClick={()=>void reload()}>读取最新作品信息（保留输入）</button>}
    <div className="wb-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="wb-primary" disabled={busy||active||otherOperation||Boolean(validation)||conflict}>{busy?'正在同步文件名…':retained?'核对原改名请求':'保存名称'}</button></div></form>
  </div></WorkbenchDialog>;
}
