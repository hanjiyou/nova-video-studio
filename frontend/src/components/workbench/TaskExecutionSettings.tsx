'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSetting, localErrorMessage, putSetting, type Setting } from '@/lib/workbench-client';
import type { TaskExecutionSettings as Values } from '@/lib/workbench-task-client';
import { isUpdateFrozen } from '@/lib/update-readiness';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';
const DEFAULTS: Values = {imageConcurrency:3,videoConcurrency:3,imageTimeoutSeconds:120,videoTimeoutSeconds:300};
const FIELDS = [ ['imageConcurrency','图片同时处理数',1,5], ['videoConcurrency','视频同时处理数',1,5], ['imageTimeoutSeconds','图片最长等待时间（秒）',30,1800], ['videoTimeoutSeconds','视频最长等待时间（秒）',30,1800] ] as const;
const strings = (value: Values) => Object.fromEntries(FIELDS.map(([key]) => [key,String(value[key])])) as Record<keyof Values,string>;
export function TaskExecutionSettings() {
 const [values,setValues]=useState(strings(DEFAULTS)),[baseline,setBaseline]=useState(strings(DEFAULTS)),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[conflict,setConflict]=useState(false);
 const saved=useRef<Setting<Values> | null>(null),pending=useRef(false),mounted=useRef(true);
 const dirty=loaded && FIELDS.some(([key])=>values[key]!==baseline[key]);
 useUpdateBlocker(()=>pending.current || dirty);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const load=useCallback(async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{const current=await getSetting<Values>('taskExecution');if(mounted.current){saved.current=current;setValues(strings(current.value || DEFAULTS));setBaseline(strings(current.value || DEFAULTS));setLoaded(true);setConflict(false);setNotice('');}}catch(error){if(mounted.current)setError(localErrorMessage(error));}finally{pending.current=false;if(mounted.current)setBusy(false);}},[]);
 useEffect(()=>{void Promise.resolve().then(load);},[load]);
 const valid=FIELDS.every(([key,,min,max])=>/^\d+$/.test(values[key])&&Number.isInteger(Number(values[key]))&&Number(values[key])>=min&&Number(values[key])<=max);
 async function save(){
  if(isUpdateFrozen()||pending.current||!loaded||!saved.current||!valid||conflict)return;
  pending.current=true;setBusy(true);setError('');setNotice('');
  try{const next=Object.fromEntries(FIELDS.map(([key])=>[key,Number(values[key])])) as unknown as Values;const current=await putSetting('taskExecution',next,saved.current.revision);if(mounted.current){saved.current=current;setValues(strings(current.value || next));setBaseline(strings(current.value || next));setNotice('任务控制已保存。并发上限用于后续入场，最长等待时间只用于新建任务。');}}
  catch(error){if(mounted.current){const changed=error instanceof Error&&error.message==='SETTING_REVISION_CONFLICT';setConflict(changed);setError(changed?'任务控制已在其他操作中修改。你的输入已保留，请重新读取后再修改保存。':localErrorMessage(error));}}
  finally{pending.current=false;if(mounted.current)setBusy(false);}
 }
 return <section className="wb-panel wb-form" aria-label="任务控制"><h2>任务控制</h2><p className="wb-help">图片和视频独立计数，默认各同时处理 3 项；图片默认 120 秒、视频默认 300 秒。名额包含请求、远端等待、下载、验证和保存。</p><div className="wb-task-settings">{FIELDS.map(([key,label,min,max])=><label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} step="1" inputMode="numeric" value={values[key]} disabled={busy||!loaded} onChange={event=>{setValues(previous=>({...previous,[key]:event.target.value}));setNotice('');}} /><small>{min}–{max}{key.endsWith('Seconds')?' 秒':' 项'}</small></label>)}</div><p className="wb-help">提高或降低并发立即影响后续入场，降低时不会打断正在处理的任务。时限从实际派发开始，排队另算；修改时限只影响之后新建的任务。</p><p className="wb-help">取消或超时停止本地等待；远端可能继续生成或计费，不代表远端取消或退款。</p>{!valid&&loaded&&<p className="wb-warning">请填写范围内的整数。</p>}{error&&<p role="alert" className="wb-error">{error}</p>}{notice&&<p role="status" className="wb-notice">{notice}</p>}<div className="wb-actions"><button type="button" disabled={busy||!loaded||!valid||conflict} onClick={()=>void save()}>{busy?'正在读取或保存…':'保存任务控制'}</button><button type="button" disabled={busy} onClick={()=>void load()}>重新读取任务控制</button></div></section>;
}
