'use client';
import {acceptTask,currentTask,watchTaskState} from '@/lib/workbench-task-state';
import {novaTaskSocket} from '@/lib/ccode-task-socket';
import { useCallback, useEffect, useRef, useState } from 'react';
import {checkConnection} from '@/lib/connection-client';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import { DEFAULT_GROUP_ID, dismissSubmission, Draft, getHistoryTask, getLocalHistory, getRecentVideoTaskLimit, getSubmissions, HistoryTask, localErrorMessage, markSubmissionAttempt, prepareSubmission, SubmissionIntent } from '@/lib/workbench-client';
import { createWorkbenchTask, WorkbenchTaskActionError } from '@/lib/workbench-task-client';
import { generationPlan } from '@/lib/workbench-generation';
import { generateUUID } from '@/lib/uuid';
import { isUpdateFrozen } from '@/lib/update-readiness';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';
export function useWorkbenchTasks(ready: boolean, kind: 'image' | 'video', connection: ConnectionSummary | null, models: ConnectionModels | null, onModels?: (value:ConnectionModels)=>void, recentVideoTaskLimit = 6, groupId = DEFAULT_GROUP_ID) {
  const requestLimit = kind === 'video' ? getRecentVideoTaskLimit(recentVideoTaskLimit) : 12;
  const [historyGroup,setHistoryGroup] = useState(groupId);
  const [historyLimit,setHistoryLimit] = useState(requestLimit);
  const [history,setHistory] = useState<Awaited<ReturnType<typeof getLocalHistory>> | null>(null), [error,setError] = useState(''), [notice,setNotice] = useState(''), [now,setNow] = useState(() => Date.now());
  const [selected,setSelected] = useState<Partial<Record<string,HistoryTask>>>({}), [submitting,setSubmitting] = useState(false), [intents,setIntents] = useState<SubmissionIntent[]>([]), [consumed,setConsumed] = useState<Partial<Record<string,string>>>({});
  const [reconciliationReady,setReconciliationReady] = useState(false);
  const [reconciliationError,setReconciliationError] = useState(''), [historyKind,setHistoryKind] = useState(kind);
  const removed = useRef(new Set<string>()),submitSequence=useRef(0),activeSubmit=useRef(0),latestAcknowledged=useRef(0),reconcileSequence=useRef(0);
  const [removedIds,setRemovedIds]=useState<Set<string>>(()=>new Set());
  const activeGroup = useRef(groupId); activeGroup.current = groupId;
  const activeLimit = useRef(requestLimit), refreshAgain = useRef(false);
  const busy = useRef(false), selection = useRef(selected), activeKind = useRef(kind), mounted = useRef(true), loading = useRef(false), fingerprints = useRef(consumed);
  useUpdateBlocker(() => busy.current || intents.length > 0 || (ready && !reconciliationReady));
  useEffect(() => { selection.current = selected; }, [selected]);
  useEffect(() => { activeKind.current = kind; activeLimit.current = requestLimit; }, [kind,requestLimit]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (loading.current) { refreshAgain.current = true; return; }
    loading.current = true;
    do {
      refreshAgain.current = false;
      const currentKind = activeKind.current, currentLimit = activeLimit.current, currentGroup = activeGroup.current, selectionKey = currentGroup + ":" + currentKind;
      const currentQuery = () => mounted.current && currentKind === activeKind.current && currentLimit === activeLimit.current && currentGroup === activeGroup.current;
      try {
        const value = await getLocalHistory({limit:currentLimit,kind:currentKind,scope:'workbench',groupId:currentGroup});
        if (!currentQuery()) continue;
        const visible = {...value,items:value.items.filter(item=>!removed.current.has(item.localTaskId) && !item.removedFromWorkbench)};
        setHistory(visible); setHistoryGroup(currentGroup); setHistoryKind(currentKind); setHistoryLimit(currentLimit); setError('');
        const chosen = selection.current[selectionKey];
        if (chosen) {
          const fresh = visible.items.find(item => item.localTaskId === chosen.localTaskId) || (removed.current.has(chosen.localTaskId) ? null : await getHistoryTask(chosen.localTaskId));
          if (currentQuery() && selection.current[selectionKey]?.localTaskId === chosen.localTaskId) {
            const next = fresh && (fresh.groupId || DEFAULT_GROUP_ID) === currentGroup && !fresh.removedFromWorkbench && !removed.current.has(fresh.localTaskId) ? fresh : undefined;
            selection.current = {...selection.current,[selectionKey]:next}; setSelected(selection.current);
          }
        }
      } catch (error) { if (currentQuery()) setError(localErrorMessage(error)); }
    } while (mounted.current && refreshAgain.current);
    loading.current = false;
  }, []);
  const reconcile = useCallback(async () => {
    const ticket=++reconcileSequence.current;
    try {
      const saved = await getSubmissions();
      for (const intent of saved) if (intent.taskId) await dismissSubmission(intent.localRequestId);
      if (mounted.current && ticket===reconcileSequence.current) { setIntents(saved.filter(item => !item.taskId)); setReconciliationReady(true); setReconciliationError(''); }
    } catch { if (mounted.current && ticket===reconcileSequence.current) { setReconciliationReady(false); setReconciliationError('暂时无法核对本地提交记录，已暂停新建生成。请重新读取，不会自动重发创建。'); } }
  }, []);
  useEffect(() => { if (!ready) return; void Promise.resolve().then(refresh); void Promise.resolve().then(reconcile); const timer = setInterval(() => { setNow(Date.now()); void refresh(); },5000); return () => clearInterval(timer); },[ready,kind,requestLimit,groupId,refresh,reconcile]);
  useEffect(()=>watchTaskState(()=>{setHistory(previous=>previous?{...previous,items:previous.items.map(currentTask)}:previous);setSelected(previous=>Object.fromEntries(Object.entries(previous).map(([key,value])=>[key,value?currentTask(value):value])));}),[]);
  const subscriptionIds=[...new Set([...(history?.items.map(task=>task.localTaskId)||[]),...Object.values(selected).filter(Boolean).map(task=>task!.localTaskId)])].join(',');
  useEffect(()=>{if(!ready)return;const stops=subscriptionIds.split(',').filter(Boolean).map(id=>novaTaskSocket.subscribeTask(id,task=>{if(task.localTaskId)acceptTask(task as unknown as HistoryTask);}));return()=>stops.forEach(stop=>stop());},[ready,subscriptionIds]);
  const draftKey = (draft: Draft) => (draft.groupId || DEFAULT_GROUP_ID) + ':' + draft.mode;
  const fingerprint = (draft: Draft) => { const plan = generationPlan(draft,connection,models); return JSON.stringify([draft.groupId || DEFAULT_GROUP_ID,connection?.connectionVersionId,plan.capability?.capabilityVersionId,plan.mode,plan.model,draft.prompt,plan.parameters,draft.inputAssets.map(item => item.assetId)]); };
  async function submit(draft: Draft) {
    let plan = generationPlan(draft,connection,models); const signature = fingerprint(draft);
    if (isUpdateFrozen() || busy.current || !reconciliationReady || plan.blocked || !connection || !plan.capability || fingerprints.current[draftKey(draft)] === signature || intents.length) return;
    const token=++submitSequence.current;activeSubmit.current=token;
    busy.current = true; setSubmitting(true); setNotice('');
    let prepared = false, attempting = false, acknowledged=false, preparedId: string | null=null;
    try {
      const refreshed=await checkConnection(connection,false,'submit').catch(error=>{if(['CONNECTION_VERSION_CONFLICT','CONNECTION_ROUTE_CONFLICT'].includes(error?.message))throw error;return null;});
      if(refreshed?.stale)throw Error('CONNECTION_VERSION_CONFLICT');
      if(refreshed?.models){onModels?.(refreshed as ConnectionModels);plan=generationPlan(draft,connection,refreshed as ConnectionModels);if(plan.blocked||!plan.capability){setNotice(plan.blocked||localErrorMessage(Error('CAPABILITY_UNVERIFIED')));return;}}
      const frozen = await prepareSubmission({groupId:draft.groupId || DEFAULT_GROUP_ID,localRequestId:generateUUID(),connectionVersionId:connection.connectionVersionId,capabilityVersionId:plan.capability.capabilityVersionId,mode:plan.mode,model:plan.model,prompt:draft.prompt,parameters:plan.parameters,inputAssets:draft.inputAssets.map((asset,position) => ({assetId:asset.assetId,role:'reference',position}))});
      prepared = true; preparedId=frozen.localRequestId;
      fingerprints.current = {...fingerprints.current,[draftKey(draft)]:signature}; setConsumed(fingerprints.current);
      await markSubmissionAttempt(frozen.localRequestId); attempting = true;
      const taskId = await createWorkbenchTask(frozen);
      acknowledged=true;latestAcknowledged.current=token;
      if(activeSubmit.current===token){busy.current=false;if(mounted.current)setSubmitting(false);}
      setNotice('任务已保存到本机，可继续准备其他任务。不会自动再次创建。');
      const task = await getHistoryTask(taskId); if(latestAcknowledged.current===token){const next={...selection.current,[(draft.groupId || DEFAULT_GROUP_ID)+':'+(plan.image?'image':'video')]:task};selection.current=next;setSelected(next);}
      await dismissSubmission(frozen.localRequestId); setNotice('任务已保存到本机并加入队列。不会自动再次创建。');
    } catch (error) {
      if(!acknowledged && preparedId && error instanceof WorkbenchTaskActionError && error.statusCode>=400 && error.statusCode<500 && ['MODEL_UNAVAILABLE','AUTH_REJECTED','CAPABILITY_UNVERIFIED','CONNECTION_VERSION_CONFLICT','INPUT_INVALID'].includes(error.code)){try{await dismissSubmission(preparedId);fingerprints.current={...fingerprints.current,[draftKey(draft)]:''};setConsumed(fingerprints.current);setNotice(localErrorMessage(Error(error.code)));return;}catch{/* Preserve intent when local cleanup is uncertain. */}}
      setNotice(acknowledged ? '任务已创建，详情或提醒暂时无法刷新。请核对本地任务，不会重新创建。' : attempting ? '本地创建回执未确认。请核对本地提交意图，不会重发创建请求。' : prepared ? '本地意图已保存；未继续发送创建请求，请核对提交意图。' : localErrorMessage(error)); }
    finally { await reconcile(); await refresh(); if(activeSubmit.current===token){busy.current=false;if(mounted.current)setSubmitting(false);} }
  }
  async function discard(intent: SubmissionIntent) { await dismissSubmission(intent.localRequestId); await reconcile(); setNotice('已结束此意图的本地核对。没有取消远端任务或释放任何任务占位；新建任务需再次明确点击生成。'); }
  function forget(taskId: string) {
    removed.current.add(taskId);setRemovedIds(new Set(removed.current));
    const next={...selection.current}; for(const key of Object.keys(next)) if(next[key]?.localTaskId===taskId) delete next[key];
    selection.current=next;setSelected(next);setHistory(previous=>previous?{...previous,items:previous.items.filter(task=>task.localTaskId!==taskId),total:Math.max(0,previous.total-(previous.items.some(task=>task.localTaskId===taskId)?1:0))}:previous);
  }
  const visibleHistory=historyKind===kind&&historyLimit===requestLimit&&historyGroup===groupId?history:null;
  return { forget, history:visibleHistory,error,notice,setNotice,now,submitting,intents,reconciliationReady,reconciliationError,refresh,reconcile,discard,submit,select:(task:HistoryTask) => { const next={...selection.current,[groupId+':'+(task.mode.startsWith('image') || task.mode.includes('to-image') ? 'image' : 'video')]:task}; selection.current=next;setSelected(next); }, selected:(selected[groupId+':'+kind] && (selected[groupId+':'+kind]!.groupId || DEFAULT_GROUP_ID) === groupId && !removedIds.has(selected[groupId+':'+kind]!.localTaskId) ? selected[groupId+':'+kind] : null) || visibleHistory?.items.find(item => !removedIds.has(item.localTaskId) && !item.removedFromWorkbench) || null, alreadySubmitted:(draft:Draft) => consumed[draftKey(draft)] === fingerprint(draft), allowAnother:(draft:Draft) => { fingerprints.current = {...fingerprints.current,[draftKey(draft)]:''}; setConsumed(fingerprints.current); } };
}
