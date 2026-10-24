'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import { dismissSubmission, Draft, getHistoryTask, getLocalHistory, getSubmissions, HistoryTask, localErrorMessage, markSubmissionAttempt, prepareSubmission, SubmissionIntent } from '@/lib/workbench-client';
import { createWorkbenchTask } from '@/lib/workbench-task-client';
import { generationPlan } from '@/lib/workbench-generation';
import { generateUUID } from '@/lib/uuid';
import { isUpdateFrozen } from '@/lib/update-readiness';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';
export function useWorkbenchTasks(ready: boolean, kind: 'image' | 'video', connection: ConnectionSummary | null, models: ConnectionModels | null) {
  const [history,setHistory] = useState<Awaited<ReturnType<typeof getLocalHistory>> | null>(null), [error,setError] = useState(''), [notice,setNotice] = useState(''), [now,setNow] = useState(() => Date.now());
  const [selected,setSelected] = useState<Partial<Record<'image'|'video',HistoryTask>>>({}), [submitting,setSubmitting] = useState(false), [intents,setIntents] = useState<SubmissionIntent[]>([]), [consumed,setConsumed] = useState<Partial<Record<string,string>>>({});
  const [reconciliationReady,setReconciliationReady] = useState(false);
  const [reconciliationError,setReconciliationError] = useState(''), [historyKind,setHistoryKind] = useState(kind);
  const busy = useRef(false), selection = useRef(selected), activeKind = useRef(kind), mounted = useRef(true), loading = useRef(false), fingerprints = useRef(consumed);
  useUpdateBlocker(() => busy.current || intents.length > 0 || (ready && !reconciliationReady));
  useEffect(() => { selection.current = selected; }, [selected]);
  useEffect(() => { activeKind.current = kind; }, [kind]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (loading.current) return; loading.current = true;
    try {
      const currentKind = activeKind.current, value = await getLocalHistory({limit:12,kind:currentKind});
      if (!mounted.current || currentKind !== activeKind.current) return;
      setHistory(value); setHistoryKind(currentKind); setError('');
      const chosen = selection.current[currentKind];
      if (chosen) { const fresh = value.items.find(item => item.localTaskId === chosen.localTaskId) || await getHistoryTask(chosen.localTaskId); if (mounted.current && currentKind === activeKind.current) setSelected(old => ({...old,[currentKind]:fresh})); }
    } catch (error) { if (mounted.current) setError(localErrorMessage(error)); } finally { loading.current = false; }
  }, []);
  const reconcile = useCallback(async () => {
    try {
      const saved = await getSubmissions();
      for (const intent of saved) if (intent.taskId) await dismissSubmission(intent.localRequestId);
      if (mounted.current) { setIntents(saved.filter(item => !item.taskId)); setReconciliationReady(true); setReconciliationError(''); }
    } catch { if (mounted.current) { setReconciliationReady(false); setReconciliationError('暂时无法核对本地提交记录，已暂停新建生成。请重新读取，不会自动重发创建。'); } }
  }, []);
  useEffect(() => { if (!ready) return; void Promise.resolve().then(refresh); void Promise.resolve().then(reconcile); const timer = setInterval(() => { setNow(Date.now()); void refresh(); },1500); return () => clearInterval(timer); },[ready,kind,refresh,reconcile]);
  const fingerprint = (draft: Draft) => { const plan = generationPlan(draft,connection,models); return JSON.stringify([connection?.connectionVersionId,plan.capability?.capabilityVersionId,plan.mode,plan.model,draft.prompt,plan.parameters,draft.inputAssets.map(item => item.assetId)]); };
  async function submit(draft: Draft) {
    const plan = generationPlan(draft,connection,models), signature = fingerprint(draft);
    if (isUpdateFrozen() || busy.current || !reconciliationReady || plan.blocked || !connection || !plan.capability || fingerprints.current[draft.mode] === signature || intents.length) return;
    busy.current = true; setSubmitting(true); setNotice('');
    let prepared = false, attempting = false;
    try {
      const frozen = await prepareSubmission({localRequestId:generateUUID(),connectionVersionId:connection.connectionVersionId,capabilityVersionId:plan.capability.capabilityVersionId,mode:plan.mode,model:plan.model,prompt:draft.prompt,parameters:plan.parameters,inputAssets:draft.inputAssets.map((asset,position) => ({assetId:asset.assetId,role:'reference',position}))});
      prepared = true;
      fingerprints.current = {...fingerprints.current,[draft.mode]:signature}; setConsumed(fingerprints.current);
      await markSubmissionAttempt(frozen.localRequestId); attempting = true;
      const taskId = await createWorkbenchTask(frozen);
      const task = await getHistoryTask(taskId); setSelected(old => ({...old,[plan.image ? 'image' : 'video']:task}));
      await dismissSubmission(frozen.localRequestId); setNotice('任务已保存到本机并加入队列。不会自动再次创建。');
    } catch (error) { setNotice(attempting ? '本地创建回执未确认。请核对本地提交意图，不会重发创建请求。' : prepared ? '本地意图已保存；未继续发送创建请求，请核对提交意图。' : localErrorMessage(error)); }
    finally { await reconcile(); await refresh(); busy.current = false; if (mounted.current) setSubmitting(false); }
  }
  async function discard(intent: SubmissionIntent) { await dismissSubmission(intent.localRequestId); await reconcile(); setNotice('已结束此意图的本地核对。没有取消远端任务或释放任何任务占位；新建任务需再次明确点击生成。'); }
  return { history:historyKind === kind ? history : null,error,notice,setNotice,now,submitting,intents,reconciliationReady,reconciliationError,refresh,reconcile,discard,submit,select:(task:HistoryTask) => setSelected(old => ({...old,[task.mode.startsWith('image') || task.mode.includes('to-image') ? 'image' : 'video']:task})), selected:selected[kind] || history?.items.find(item => kind === 'image' ? item.mode.startsWith('image') || item.mode.includes('to-image') : item.mode.startsWith('video') || item.mode === 'plugin') || null, alreadySubmitted:(draft:Draft) => consumed[draft.mode] === fingerprint(draft), allowAnother:(draft:Draft) => { fingerprints.current = {...fingerprints.current,[draft.mode]:''}; setConsumed(fingerprints.current); } };
}
