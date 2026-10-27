"use client";
import { useEffect, useState } from 'react';
import { groupOperationPending, moveTaskGroup, groupReceiptUnknown, reconcileGroupMove, unconfirmedGroupInput, watchGroupOperations } from '@/lib/workbench-group-client';
import { DEFAULT_GROUP_ID, localErrorMessage, type HistoryTask, type WorkbenchGroup } from '@/lib/workbench-client';
import { taskExecutionActive } from '@/lib/workbench-generation';
import { WorkbenchDialog } from './WorkbenchResults';
export function GroupMoveDialog({ task, groups, onClose, onMoved }: { task: HistoryTask; groups: WorkbenchGroup[]; onClose: () => void; onMoved: (task: HistoryTask) => void }) {
  reconcileGroupMove(task);
  const retained=unconfirmedGroupInput('task:'+task.localTaskId) as {groupId:string}|undefined;
  const [groupId, setGroupId] = useState(retained?.groupId || task.groupId || DEFAULT_GROUP_ID), [notice, setNotice] = useState(''), [, render] = useState(0);
  useEffect(() => watchGroupOperations(() => render(value => value + 1)), []);
  const busy = groupOperationPending('task:' + task.localTaskId), active = taskExecutionActive(task), sourceRecovery = groups.some(group=>group.groupId===task.groupId&&group.recoveryRequired), targetBlocked=!groups.some(group=>group.groupId===groupId&&!group.archived&&!group.recoveryRequired);
  async function move() { if (busy || active || sourceRecovery || targetBlocked || !groupId || groupId === (task.groupId || DEFAULT_GROUP_ID)) return; setNotice(''); try { const result = await moveTaskGroup(task, groupId); onMoved(result.task); onClose(); } catch (error) { setNotice(groupReceiptUnknown(error)?'改组回执未确认，目标已锁定，请再次确认以核对原请求。'+localErrorMessage(error):localErrorMessage(error)); } }
  return <WorkbenchDialog title="修改任务分组" onClose={() => { if (!busy) onClose(); }}><p>该任务的全部正式输出作为一组整理。文件在任务原保存根目录下移动，不会重新生成。</p><p className="wb-help wb-output-location">当前实际位置：{task.outputLocation || '尚未记录正式文件位置'}</p>{!task.outputAssets?.length && <p className="wb-help">尚无完整成品；将更新归属，已保存的完整文件一并整理。原提交快照保留。</p>}<label>目标剧本<select value={groupId} disabled={busy || active || Boolean(retained)} onChange={event => setGroupId(event.target.value)}>{groups.filter(group => !group.archived || group.groupId===task.groupId).map(group => <option key={group.groupId} value={group.groupId} disabled={Boolean(group.archived||group.recoveryRequired)}>{group.name}{group.archived?'（已归档）':group.recoveryRequired?'（待恢复）':''}</option>)}</select></label>{sourceRecovery&&<p className="wb-warning">当前剧本有尚未恢复的文件整理，请先重试恢复整理。</p>}{active && <p className="wb-warning">任务仍在本地执行或写入文件，请等待结束后再改组。</p>}<div className="wb-actions"><button type="button" disabled={busy} onClick={onClose}>保留当前分组</button><button type="button" disabled={busy || active || sourceRecovery || targetBlocked || !groupId || groupId === (task.groupId || DEFAULT_GROUP_ID)} onClick={() => void move()}>{busy ? '正在整理文件…' : '确认修改分组'}</button></div>{notice && <p role="alert" className="wb-error">{notice}</p>}</WorkbenchDialog>;
}
