"use client";
import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { HistoryTask } from '@/lib/workbench-client';
import { retryOriginalDownload, downloadRequestPending, WorkbenchTaskActionError } from '@/lib/workbench-task-client';
import { currentTask, taskObservedAt, watchTaskState } from '@/lib/workbench-task-state';
export const formatDownloadBytes = (bytes: number) => bytes >= 1000000 ? (bytes / 1000000).toFixed(1) + ' MB' : bytes >= 1000 ? (bytes / 1000).toFixed(1) + ' KB' : Math.round(bytes) + ' B';
function useDownloadTask(initial: HistoryTask) {
  const [, render] = useState(0);
  const source=useRef(initial), task=currentTask(initial), observed=useRef({task,pending:downloadRequestPending(task.localTaskId)});
  source.current=initial;observed.current={task,pending:downloadRequestPending(task.localTaskId)};
  useEffect(() => watchTaskState(() => {const next=currentTask(source.current);if(next!==observed.current.task||downloadRequestPending(next.localTaskId)!==observed.current.pending)render(value => value + 1);}), []);
  return task;
}
export function DownloadRetryAction({ task: initial }: { task: HistoryTask }) {
  const task = useDownloadTask(initial), active = task.downloadAttempt?.active, pending = downloadRequestPending(task.localTaskId);
  const [notice, setNotice] = useState<{ revision: number | undefined; message: string } | null>(null);
  if (!task.canRetryDownload && !pending) return null;
  return <><button type="button" disabled={pending || Boolean(active)} onClick={() => {
    setNotice(null);
    void retryOriginalDownload(task.localTaskId).catch(error => setNotice({ revision: task.revision, message: error instanceof WorkbenchTaskActionError && error.statusCode < 500 ? '重新下载请求未受理：' + error.message : '重新下载请求回执未确认，请再次点击核对原下载请求。' }));
  }}>{pending ? '正在请求重新下载…' : '重新下载'}</button>{notice && notice.revision === task.revision && !active && !pending && <p role="status" className="wb-help">{notice.message}</p>}</>;
}
export function DownloadStatus({ task: initial, actions = true, showPhase = true }: { task: HistoryTask; actions?: boolean; showPhase?: boolean }) {
  const task = useDownloadTask(initial), [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const progress = task.downloadProgress, active = task.downloadAttempt?.active;
  const stale = Boolean(active && taskObservedAt(task.localTaskId) && now - taskObservedAt(task.localTaskId) > 5000);
  const bytes = progress?.receivedBytes || 0, known = progress?.totalBytes != null, speed = active && progress?.phase === 'downloading' && !stale && !progress.stalled ? (progress?.bytesPerSecond || 0) : 0;
  const image = task.mediaKind === 'image' || task.mode.startsWith('image') || task.mode.includes('to-image');
  const failure = task.status === 'download_failed' && (task.generationOutcome === 'completed' || task.remoteOutcome === 'confirmed_result');
  const phase = ({ waiting: '等待下载', refreshing: '刷新原任务链接', downloading: '下载中', validating: '校验中', saving: '保存中', completed: '完成', failed: '下载失败', cancelled: '已取消' })[progress?.phase || 'waiting'];
  if (task.status === 'completed' && !task.canRetryDownload && !task.outputAssets?.some(asset => asset.availability !== 'available')) return null;
  if (!progress && !active && !failure && !task.canRetryDownload) return null;
  return <div className="wb-download-status" aria-live="polite">
    {failure ? <p className="wb-download-phase wb-error"><TriangleAlert size={15} aria-hidden="true" />{image ? '图片' : '视频'}已生成，下载失败</p> : showPhase && active && <p className="wb-download-phase">{progress?.phase === 'validating' || progress?.phase === 'saving' ? <LoaderCircle size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}{phase}</p>}
    {progress && <>
      {progress.sourceKind === 'reused' ? <p className="wb-help">已复用完整验证文件 {formatDownloadBytes(bytes)}</p> : progress.sourceKind === 'asset' ? <p className="wb-help">结果已接收</p> : <>
        <div className="wb-download-data"><span>已下载 {formatDownloadBytes(bytes)}{known ? ' / ' + formatDownloadBytes(progress.totalBytes!) : ' · 总大小未知'}</span>{known && progress.percent != null && <strong>{progress.percent}%</strong>}</div>
        {known ? <progress className="wb-download-progress" aria-label="当前文件下载进度" max={100} value={progress.percent ?? 0} /> : <div className="wb-download-indeterminate" aria-hidden="true"><span /></div>}
        <p className="wb-download-speed">{formatDownloadBytes(speed)}/s</p>
      </>}
      {progress.fileCount > 1 && progress.fileIndex > 0 && <p className="wb-help wb-download-files">第 {progress.fileIndex} / {progress.fileCount} 个文件 · 整体已保存 {progress.savedFileCount} / {progress.fileCount}{progress.reusedBytes > 0 && ' · 已复用 ' + formatDownloadBytes(progress.reusedBytes)}</p>}
      {(stale || progress.stalled) && active && <p className="wb-warning">{stale ? '进度暂不可用，正在重新连接' : '暂未收到数据，请检查网络或代理接管情况'}</p>}
      {active && progress.percent === 100 && ['validating', 'saving'].includes(progress.phase) && !showPhase && <p className="wb-help">完整校验与保存后才算完成</p>}
    </>}
    {failure && task.taskError && <p className="wb-help wb-download-error">{task.taskError.message}</p>}
    {task.recoveryReason && <p className="wb-help">{task.recoveryReason}</p>}
    {(failure || task.canRetryDownload || (task.downloadAttempt?.attemptNumber || 1) > 1) && <p className="wb-help">重新下载只获取原任务结果，不会重新生成。</p>}
    {actions && <div className="wb-download-actions"><DownloadRetryAction task={task} /></div>}
  </div>;
}
