"use client";
import { useEffect, useRef, useState } from 'react';
import { getLocalHistory, localErrorMessage, type HistoryQuery, type HistoryTask, type WorkbenchGroup } from '@/lib/workbench-client';
import { MediaTaskCard } from './MediaTaskCard';
import { WorkbenchDialog } from './WorkbenchResults';
export function WorkbenchAllTasks({ groupId: initialGroup, groups, now, onClose, onDetails, onChanged, onRemoved, onRegroup, groupsReady=true }: { groupId: string; groups: WorkbenchGroup[]; now: number; onClose: () => void; onDetails: (task: HistoryTask) => void; onChanged: () => void; onRemoved: (id: string) => void; onRegroup: (task: HistoryTask) => void; groupsReady?: boolean }) {
  const [groupId, setGroupId] = useState(initialGroup), [category, setCategory] = useState<HistoryQuery['category']>('all'), [offset, setOffset] = useState(0), [reload, setReload] = useState(0);
  useEffect(()=>{if(groupsReady&&groupId&&!groups.some(group=>group.groupId===groupId)){setGroupId('');setOffset(0);}},[groupsReady,groups,groupId]);
  const [result, setResult] = useState<Awaited<ReturnType<typeof getLocalHistory>> | null>(null), [resultKey, setResultKey] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const sequence = useRef(0), limit = 12, queryKey = JSON.stringify([groupId, category, offset]);
  const visible = queryKey === resultKey ? result : null;
  useEffect(() => {
    let active = true; const ticket = ++sequence.current; setLoading(true);
    void getLocalHistory({ scope: 'workbench', groupId, category: category === 'all' ? undefined : category, limit, offset }).then(value => {
      if (!active || sequence.current !== ticket) return;
      setResult(value); setResultKey(queryKey); setError('');
      if (offset && offset >= value.total) setOffset(Math.max(0, Math.floor((value.total - 1) / limit) * limit));
    }).catch(error => { if (active && sequence.current === ticket) setError(localErrorMessage(error)); }).finally(() => { if (active && sequence.current === ticket) setLoading(false); });
    return () => { active = false; };
  }, [groupId, category, offset, reload, queryKey]);
  useEffect(() => { const timer = setInterval(() => setReload(value => value + 1), 5000); return () => clearInterval(timer); }, []);
  const changed = () => { setReload(value => value + 1); onChanged(); };
  return <WorkbenchDialog title="全部任务" onClose={onClose}><p className="wb-help">这里保留生成、下载、失败和需人工处理的任务。未完成包含超时、取消、提交结果待核对、查询暂停与尚未完整保存的结果。</p><div className="wb-all-tasks-filters"><label>任务所属剧本<select value={groupId} onChange={event => { setGroupId(event.target.value); setOffset(0); }}><option value="">全部剧本</option>{groups.map(group => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}</select></label><label>任务分类<select value={category} onChange={event => { setCategory(event.target.value as HistoryQuery['category']); setOffset(0); }}><option value="all">全部</option><option value="active">进行中</option><option value="unfinished">未完成</option><option value="completed">已完成</option></select></label></div>{error && <p role="alert" className="wb-error">{error}<button type="button" onClick={() => setReload(value => value + 1)}>重新读取任务</button></p>}{!visible ? <p role="status">正在读取任务…</p> : <><div className="wb-recent-list" aria-busy={loading}>{visible.items.map(task => <MediaTaskCard key={task.localTaskId} task={task} now={now} onPreview={() => onDetails(task)} onDetails={() => onDetails(task)} onChanged={changed} onRegroup={()=>onRegroup(task)} onRemoved={id => { onRemoved(id); changed(); }}/>)}</div>{!visible.total && <p className="wb-help">没有符合条件的任务。</p>}<div className="wb-pagination"><button type="button" disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - limit))}>上一页</button><span>第 {Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil(visible.total / limit))} 页 · {visible.total} 条</span><button type="button" disabled={offset + limit >= visible.total || loading} onClick={() => setOffset(value => value + limit)}>下一页</button></div></>}</WorkbenchDialog>;
}
