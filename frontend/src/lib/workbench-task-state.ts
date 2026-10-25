import type { WorkbenchTaskResponse } from './workbench-task-client';
const tasks=new Map<string,WorkbenchTaskResponse>();
const removed=new Set<string>();
const listeners=new Set<()=>void>();
const observed=new Map<string,number>();
export const watchTaskState=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
export const notifyTaskState=()=>listeners.forEach(listener=>listener());
export function acceptTask<T extends WorkbenchTaskResponse>(task:T):T {
 const id=task.localTaskId||task.id,old=tasks.get(id);
 if(old && old.revision!==undefined && task.revision!==undefined && old.revision>=task.revision)return old as T;
 if(old?.removedFromWorkbench&&!task.removedFromWorkbench)return old as T;
 if(!old||(task.revision??0)>(old.revision??0))observed.set(id,Date.now());
 const next={...old,...task,...(removed.has(id)?{removedFromWorkbench:true}:{})} as T;tasks.set(id,next);
 if(tasks.size>256){const victim=[...tasks].find(([key,value])=>key!==id&&!value.localExecutionActive&&!value.downloadAttempt?.active);if(victim){tasks.delete(victim[0]);observed.delete(victim[0]);}}
 notifyTaskState();return next;
}
export const currentTask=<T extends WorkbenchTaskResponse>(task:T):T=>(tasks.get(task.localTaskId||task.id) as T)||task;
export const taskObservedAt=(id:string)=>observed.get(id)??0;
export function markTaskRemoved(id:string){removed.add(id);const task=tasks.get(id);if(task)tasks.set(id,{...task,removedFromWorkbench:true});notifyTaskState();}

export function resetTaskStateForTests(){tasks.clear();observed.clear();removed.clear();}
