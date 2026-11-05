'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_EDITOR_SETTINGS, MIN_STARTUP_SECONDS, MAX_STARTUP_SECONDS } from '../../../../backend/storage/editor-settings';
import { getSetting, putSetting, localErrorMessage, type Setting } from '@/lib/workbench-client';
import { isUpdateFrozen } from '@/lib/update-readiness';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';
type Values = { startupTimeoutSeconds: number };

export function EditorStartupSettings() {
  const [input,setInput]=useState(String(DEFAULT_EDITOR_SETTINGS.startupTimeoutSeconds)),[baseline,setBaseline]=useState(input);
  const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[conflict,setConflict]=useState(false);
  const saved=useRef<Setting<Values>|null>(null),pending=useRef(false),mounted=useRef(true);
  useUpdateBlocker(()=>pending.current || loaded && input!==baseline);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function accept(current:Setting<Values>) {
    saved.current=current;const seconds=String(current.value?.startupTimeoutSeconds ?? DEFAULT_EDITOR_SETTINGS.startupTimeoutSeconds);
    setInput(seconds);setBaseline(seconds);setLoaded(true);setConflict(false);
  }
  const load=useCallback(async()=>{
    if(pending.current || isUpdateFrozen())return;
    pending.current=true;setBusy(true);setError('');setNotice('');
    try{const current=await getSetting<Values>('editor');if(mounted.current)accept(current);}
    catch(error){if(mounted.current)setError(localErrorMessage(error));}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  },[]);
  useEffect(()=>{void Promise.resolve().then(load);},[load]);
  const valid=/^\d+$/.test(input)&&Number.isInteger(Number(input))&&Number(input)>=MIN_STARTUP_SECONDS&&Number(input)<=MAX_STARTUP_SECONDS;
  async function save(){
    if(isUpdateFrozen()||pending.current||!loaded||!saved.current||!valid||conflict)return;
    pending.current=true;setBusy(true);setError('');setNotice('');
    try{const current=await putSetting('editor',{startupTimeoutSeconds:Number(input)},saved.current.revision);if(mounted.current){accept(current);setNotice('剪辑启动设置已保存，下次启动剪辑时生效。');}}
    catch(error){if(mounted.current){const changed=error instanceof Error&&error.message==='SETTING_REVISION_CONFLICT';setConflict(changed);setError(changed?'设置已在其他操作中修改，你的输入已保留。请重新读取后再修改保存。':localErrorMessage(error));}}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  }
  return <section className="wb-panel wb-form" aria-label="视频剪辑设置"><h2>视频剪辑</h2>
    <label>剪辑启动超时（秒）<input type="number" min={MIN_STARTUP_SECONDS} max={MAX_STARTUP_SECONDS} step="1" inputMode="numeric" value={input} disabled={busy||!loaded} onChange={event=>{setInput(event.target.value);setNotice('');}} /></label>
    <p className="wb-help">默认 {DEFAULT_EDITOR_SETTINGS.startupTimeoutSeconds} 秒，可设为 {MIN_STARTUP_SECONDS}–{MAX_STARTUP_SECONDS} 的整数。保存后在重启应用后保留，下次启动剪辑时生效；不影响正在启动或已经打开的剪辑。</p>
    {loaded&&!valid&&<p className="wb-warning">请填写 {MIN_STARTUP_SECONDS}–{MAX_STARTUP_SECONDS} 的整数，不能为空。</p>}
    {error&&<p role="alert" className="wb-error">{error}</p>}{notice&&<p role="status" className="wb-notice">{notice}</p>}
    <div className="wb-actions"><button type="button" disabled={busy||!loaded||!valid||conflict} onClick={()=>void save()}>{busy?'正在读取或保存…':'保存剪辑设置'}</button><button type="button" disabled={busy} onClick={()=>void load()}>重新读取剪辑设置</button></div>
  </section>;
}
