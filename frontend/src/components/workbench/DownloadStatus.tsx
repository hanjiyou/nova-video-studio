"use client";
import {useEffect,useState} from 'react';
import type {HistoryTask} from '@/lib/workbench-client';
import {retryOriginalDownload,downloadRequestPending,WorkbenchTaskActionError} from '@/lib/workbench-task-client';
import {currentTask,taskObservedAt,watchTaskState} from '@/lib/workbench-task-state';
export const formatDownloadBytes=(bytes:number)=>bytes>=1000000?(bytes/1000000).toFixed(1)+' MB':bytes>=1000?(bytes/1000).toFixed(1)+' KB':Math.round(bytes)+' B';
export function DownloadStatus({task:initial,actions=true}:{task:HistoryTask;actions?:boolean}){
 const [,render]=useState(0),[notice,setNotice]=useState<{taskId:string;revision:number|undefined;message:string}|null>(null),[now,setNow]=useState(Date.now());
 useEffect(()=>watchTaskState(()=>render(value=>value+1)),[]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const task=currentTask(initial),progress=task.downloadProgress,active=task.downloadAttempt?.active,pending=downloadRequestPending(task.localTaskId);
 const stale=Boolean(active&&taskObservedAt(task.localTaskId)&&now-taskObservedAt(task.localTaskId)>5000);
 const bytes=progress?.receivedBytes||0,known=progress?.totalBytes!=null,speed=active&&!stale?(progress?.bytesPerSecond||0):0;
 const image=task.mediaKind==='image'||task.mode.startsWith('image')||task.mode.includes('to-image');
 const failure=task.status==='download_failed'&&(task.generationOutcome==='completed'||task.remoteOutcome==='confirmed_result');
 if(task.status==='completed'&&!task.canRetryDownload&&!task.outputAssets?.some(asset=>asset.availability!=='available'))return null;
 if(!progress&&!active&&!failure&&!task.canRetryDownload)return null;
 return <div className="wb-download-status" aria-live="polite">{failure&&<p className="wb-error">{image?'图片':'视频'}已生成，下载失败</p>}{active&&<p>{({waiting:'等待下载',refreshing:'刷新原任务链接',downloading:'下载中',validating:'校验中',saving:'保存中',completed:'完成',failed:'下载失败',cancelled:'已取消'}[progress?.phase||'waiting'])}</p>}{progress&&<><p className="wb-help">{progress.sourceKind==='reused'?'已复用完整验证文件 '+formatDownloadBytes(bytes):progress.sourceKind==='asset'?'结果已接收':`已下载 ${formatDownloadBytes(bytes)}${known?' / '+formatDownloadBytes(progress.totalBytes!):' · 总大小未知'} · ${formatDownloadBytes(speed)}/s${known?' · '+progress.percent+'%':''}`}</p>{known&&progress.sourceKind!=='asset'&&progress.sourceKind!=='reused'&&<progress aria-label="当前文件下载进度" max={100} value={progress.percent??0} style={{width:'100%',accentColor:'#a78bfa'}}/>}{progress.fileCount>1&&progress.fileIndex>0&&<p className="wb-help">第 {progress.fileIndex} / {progress.fileCount} 个文件 · 整体已保存 {progress.savedFileCount} / {progress.fileCount}{progress.reusedBytes>0&&' · 已复用 '+formatDownloadBytes(progress.reusedBytes)}</p>}{(stale||progress.stalled)&&active&&<p className="wb-warning">{stale?'进度暂不可用，正在重新连接':'暂未收到数据，请检查网络或代理接管情况'}</p>}</>}{failure&&task.taskError&&<p className="wb-help">{task.taskError.message}</p>}{task.recoveryReason&&<p className="wb-help">{task.recoveryReason}</p>}{actions&&(task.canRetryDownload||pending)&&<button type="button" disabled={pending||Boolean(active)} onClick={()=>{setNotice(null);void retryOriginalDownload(task.localTaskId).catch(error=>setNotice({taskId:task.localTaskId,revision:task.revision,message:error instanceof WorkbenchTaskActionError&&error.statusCode<500?'重新下载请求未受理：'+error.message:'重新下载请求回执未确认，请再次点击核对原下载请求。'}));}}>{pending?'正在请求重新下载…':'重新下载'}</button>}{(active||task.canRetryDownload)&&<p className="wb-help">重新下载只获取原任务结果，不会重新生成。</p>}{notice&&notice.taskId===task.localTaskId&&notice.revision===task.revision&&!active&&!pending&&<p role="status" className="wb-help">{notice.message}</p>}</div>;
}
