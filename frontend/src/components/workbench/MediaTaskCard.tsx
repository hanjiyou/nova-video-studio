"use client";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { currentTask,watchTaskState } from '@/lib/workbench-task-state';
import { groupOperationPending,watchGroupOperations } from '@/lib/workbench-group-client';
import type { HistoryTask } from '@/lib/workbench-client';
import { DownloadStatus } from './DownloadStatus';
import { TaskBadge, TaskControls, TaskThumbnail, TaskTiming } from './WorkbenchResults';
export function MediaTaskCard({ task: initial, variant = 'task', now = Date.now(), onPreview, onDetails, onChanged, onRemoved, actions, menu, draggable = false, onDragStart, onDragEnd, onRegroup }: { task: HistoryTask; variant?: 'task' | 'library'; now?: number; onPreview: () => void; onDetails: () => void; onChanged?: () => void; onRemoved?: (id: string) => void; actions?: ReactNode; menu?: ReactNode; draggable?: boolean; onDragStart?: React.DragEventHandler<HTMLElement>; onDragEnd?: React.DragEventHandler<HTMLElement>; onRegroup?: () => void }) {
  const [,render] = useState(0), draggedAt = useRef(0), source = useRef(initial), shown = useRef(initial);
  source.current=initial;
  useEffect(()=>{const update=()=>render(value=>value+1),stopTasks=watchTaskState(()=>{if(currentTask(source.current)!==shown.current)update();}),stopMoves=watchGroupOperations(update);return()=>{stopTasks();stopMoves();};},[]);
  const task=currentTask(initial);shown.current=task;
  const moving=groupOperationPending('task:'+task.localTaskId), library = variant === 'library';
  return <article className="wb-media-card" data-task-id={task.localTaskId} draggable={draggable && !moving} data-group-moving={moving || undefined} onDragStart={event=>{if((event.target as HTMLElement).closest('.wb-card-actions')||moving){event.preventDefault();return;}draggedAt.current=Date.now();onDragStart?.(event);}} onDragEnd={event=>{draggedAt.current=Date.now();onDragEnd?.(event);}}>
    <button type="button" className="wb-card-open" aria-label={(library ? '预览作品：' : '预览任务：') + (task.prompt || task.localTaskId)} title={library ? '双击预览，或按 Enter / 空格键预览' : '预览任务'} onClick={library ? undefined : onPreview} onDoubleClick={library ? () => {if(Date.now()-draggedAt.current>350&&!moving)onPreview();} : undefined} onKeyDown={event => { if (library && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onPreview(); } }}>
      <TaskThumbnail task={task} />
      <div className="wb-card-info">{(!library || task.outputAssets?.some(asset => asset.availability !== 'available')) && <TaskBadge task={task} />}<p className="wb-card-prompt">{task.prompt || '未填写提示词'}</p><small title={task.model} className="wb-card-model">{task.model}</small><small>{new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small>{library && <small className="wb-card-preview-hint">双击预览{(task.outputAssets?.[0] ? task.outputAssets[0].kind === 'image' : task.mediaKind === 'image' || task.mode.startsWith('image') || task.mode.includes('to-image')) ? '图片' : '视频'}</small>}</div>
    </button>
    {!library && <div className="wb-card-state"><TaskTiming task={task} now={now} compact/><DownloadStatus task={task} actions={false} showPhase={false}/>{task.taskError && task.status !== 'download_failed' && <p className="wb-error">{task.taskError.message}</p>}{task.remoteMayContinue && <p className="wb-warning">远端可能仍在生成或计费；本地取消和超时不代表远端取消或退款。</p>}{task.requiresContinue && <p className="wb-warning">重启后等待明确继续；不会自动重新提交生成。</p>}</div>}
    <div className="wb-card-actions"><button type="button" className="wb-link" onClick={onDetails}>任务详情</button>{actions}{!library && <TaskControls task={task} compact onChanged={onChanged || (() => {})} onRemoved={onRemoved} onRegroup={onRegroup}/>} {menu}</div>
  </article>;
}
