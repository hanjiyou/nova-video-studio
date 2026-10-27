"use client";
import { useRef, useState } from 'react';
import { recoverGroupOperations } from '@/lib/workbench-group-client';
import { localErrorMessage, type GroupRecovery, type WorkbenchGroup } from '@/lib/workbench-client';
export function GroupRecoveryBanner({ recovery, groups, onChanged }: { recovery: GroupRecovery[]; groups: WorkbenchGroup[]; onChanged: () => void }) {
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),lock=useRef(false);
 if(!recovery.length)return null;
 async function recover(){if(lock.current)return;lock.current=true;setBusy(true);setNotice('');try{const result=await recoverGroupOperations();setNotice(result.unresolved.length ? `仍有 ${result.unresolved.length} 条整理未能恢复，请检查原目录、权限或文件占用。` : '文件整理状态已恢复。');onChanged();}catch(error){setNotice(localErrorMessage(error));}finally{lock.current=false;setBusy(false);}}
 return <div className="wb-notice"><h3>文件整理需要处理</h3><p>有 {recovery.length} 条整理尚未安全收尾，涉及的分组暂不能继续写入；其他剧本仍可使用。</p>{recovery.map(item=><p className="wb-help" key={item.operationId}>{item.groupIds.map(id=>groups.find(group=>group.groupId===id)?.name||id).join('、')}：{localErrorMessage(Error(item.code))}</p>)}<button type="button" disabled={busy} onClick={()=>void recover()}>{busy?'正在恢复整理…':'重试恢复整理'}</button>{notice&&<p role="status">{notice}</p>}</div>;
}
