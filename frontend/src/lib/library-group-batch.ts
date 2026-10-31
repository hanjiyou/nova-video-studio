import type { HistoryTask } from './workbench-client';
import { localErrorMessage } from './workbench-client';
import { groupReceiptUnknown, moveTaskGroup, unconfirmedGroupInput } from './workbench-group-client';
export interface LibraryMoveResult {task:HistoryTask;status:'succeeded'|'failed'|'unknown'|'skipped'|'not_started';message?:string}
export interface LibraryMoveBatch {groupId:string;items:LibraryMoveResult[];total:number;succeeded:number;failed:number;unknown:number;skipped:number}
export const summarizeLibraryMoves=(groupId:string,tasks:readonly HistoryTask[],items:LibraryMoveResult[]):LibraryMoveBatch=>({groupId,items:[...items],total:tasks.length,succeeded:items.filter(i=>i.status==='succeeded').length,failed:items.filter(i=>i.status==='failed').length,unknown:items.filter(i=>i.status==='unknown').length,skipped:items.filter(i=>i.status==='skipped').length});
export async function moveLibraryTasks(tasks:readonly HistoryTask[],groupId:string,options:{cancelled:()=>boolean;progress:(result:LibraryMoveBatch)=>void}) {
 const frozen=tasks.map(task=>({...task})),items:LibraryMoveResult[]=[];
 for(const task of frozen) {
  if(options.cancelled())break;
  const retained=unconfirmedGroupInput('task:'+task.localTaskId) as {groupId?:string}|undefined;
  if(task.groupId===groupId&&!retained)items.push({task,status:'skipped'});
  else try {const result=await moveTaskGroup(task,groupId);items.push({task:result.task,status:result.unchanged?'skipped':'succeeded'});}
  catch(error){items.push({task,status:groupReceiptUnknown(error)||(error as {code?:string}).code==='GROUP_REQUEST_UNCONFIRMED'?'unknown':'failed',message:localErrorMessage(error)});}
  if(!options.cancelled())options.progress(summarizeLibraryMoves(groupId,frozen,items));
 }
 for(const task of frozen.slice(items.length))items.push({task,status:'not_started'});
 return summarizeLibraryMoves(groupId,frozen,items);
}
