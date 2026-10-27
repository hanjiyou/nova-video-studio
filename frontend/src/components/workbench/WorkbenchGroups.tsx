"use client";
import { useRef, useState } from 'react';
import { createWorkbenchGroup, localErrorMessage, type WorkbenchGroup } from '@/lib/workbench-client';
import { archiveWorkbenchGroup, deleteWorkbenchGroup, renameWorkbenchGroup, groupReceiptUnknown, unconfirmedGroupInput } from '@/lib/workbench-group-client';
import { HistoryOrganizer } from './HistoryOrganizer';
import { WorkbenchDialog } from './WorkbenchResults';
export function GroupPicker({ groups, groupId, disabled, mediaKind, onChange, onManage }: { groups: WorkbenchGroup[]; groupId: string; disabled?: boolean; mediaKind: 'image' | 'video'; onChange: (groupId: string) => void; onManage: () => void }) {
  const group = groups.find(item => item.groupId === groupId);
  const outputLocation = group?.outputLocation ? group.outputLocation.replace(/[\\/]+$/, '') + '\\' + (mediaKind === 'image' ? '图片' : '视频') : '';
  return <div className="wb-group-picker"><div><label>所属剧本<select value={groupId} disabled={disabled} onChange={event => onChange(event.target.value)}>{!group && <option value={groupId}>当前剧本（正在读取）</option>}{groups.filter(item => !item.archived || item.groupId === groupId).map(item => <option key={item.groupId} value={item.groupId}>{item.name}{item.archived ? '（已归档）' : ''}</option>)}</select></label><button type="button" disabled={disabled} onClick={onManage}>管理分组</button></div><p className="wb-help wb-output-location">新任务保存位置：<span title={outputLocation}>{outputLocation || '正在读取本机保存位置…'}</span></p></div>;
}
export function GroupManager({ groups, onChanged, onClose, beforeDelete }: { groups: WorkbenchGroup[]; onChanged: () => void; onClose: () => void; beforeDelete: (groupId: string) => Promise<void> }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [editing, setEditing] = useState<string | null>(null), [editName,setEditName] = useState('');
  const [deleting,setDeleting] = useState<WorkbenchGroup | null>(null), [history,setHistory] = useState(false);
  const lock = useRef(false);
  async function run(operation: () => Promise<unknown>, message: string) {
    if (lock.current) return; lock.current = true; setBusy(true); setNotice('');
    try { await operation(); onChanged(); setNotice(message); }
    catch (error) { setNotice(groupReceiptUnknown(error)?'操作回执未确认，请保持原参数并再次点击相同操作核对。'+localErrorMessage(error):localErrorMessage(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <WorkbenchDialog title={deleting ? '删除空分组' : history ? '整理历史文件' : '剧本分组'} onClose={() => { if (!busy) onClose(); }}>
    {deleting ? <><p>确认删除空剧本“{deleting.name}”？仅允许没有任务、作品、草稿内容和目录文件的自建分组。已有文件不会被删除。</p><div className="wb-actions"><button type="button" disabled={busy} onClick={() => {setDeleting(null);setNotice('');}}>保留分组</button><button type="button" disabled={busy} onClick={() => void run(async () => { await beforeDelete(deleting.groupId); await deleteWorkbenchGroup(deleting.groupId); setDeleting(null); }, '空分组已删除。')}>确认删除空分组</button></div></> : history ? <><button type="button" className="wb-link" disabled={busy} onClick={() => setHistory(false)}>返回分组管理</button><HistoryOrganizer onChanged={onChanged} onBusyChange={setBusy}/></> : <>
      <p className="wb-help">图片与视频共享分组。新任务使用当前保存根目录，历史任务保留原根目录。归档保留历史与文件，组重命名同步所有受管位置。</p>
      <ul className="wb-group-management">{groups.map(group => <li key={group.groupId}><strong>{group.name}{group.archived ? '（已归档）' : ''}</strong>{group.isDefault && <span className="wb-help">系统分组</span>}<span className="wb-output-location">{group.outputLocation}</span>{!group.isDefault && <div className="wb-actions">{editing === group.groupId ? <><label>新的剧本名称<input value={editName} maxLength={48} disabled={busy || Boolean(unconfirmedGroupInput('rename:'+group.groupId))} onChange={event => setEditName(event.target.value)}/></label><button type="button" disabled={busy || !editName.trim() || editName === group.name} onClick={() => void run(async () => {await renameWorkbenchGroup(group.groupId,editName);setEditing(null);},'分组名称与受管目录已更新。')}>保存名称</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>取消改名</button></> : <><button type="button" disabled={busy} onClick={() => {setEditing(group.groupId);setEditName((unconfirmedGroupInput('rename:'+group.groupId) as {name:string}|undefined)?.name||group.name);setNotice('');}}>重命名</button><button type="button" disabled={busy} onClick={() => void run(() => archiveWorkbenchGroup(group.groupId,!group.archived),group.archived ? '分组已取消归档。' : '分组已归档，文件与历史保留。')}>{group.archived ? '取消归档' : '归档'}</button><button type="button" disabled={busy} onClick={() => {setDeleting(group);setNotice('');}}>删除空分组</button></>}</div>}</li>)}</ul>
      <label>新剧本名称<input value={name} disabled={busy} maxLength={48} onChange={event => setName(event.target.value)} placeholder="例如：海边短片" /></label><div className="wb-actions"><button type="button" disabled={busy || !name.trim()} onClick={() => void run(async () => {await createWorkbenchGroup(name);setName('');},'剧本分组已创建。')}>{busy ? '正在处理分组…' : '新建分组'}</button><button type="button" disabled={busy} onClick={() => setHistory(true)}>预览并整理历史文件</button></div>
    </>}{notice && <p role="status" className="wb-notice">{notice}</p>}
  </WorkbenchDialog>;
}
