'use client';
import { useEffect, useRef, useState } from 'react';
import {checkConnection,saveModelSettings} from '@/lib/connection-client';
import {modelOptions,defaultModel,classifiedModels,modelSubmissionEnabled} from '@/lib/workbench-model-catalog';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import { localErrorMessage, PRESET_MODELS } from '@/lib/workbench-client';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';
export interface OutputDirectory { ok: boolean; displayName?: string; outputDirectoryVersionId?: string; outputRootRef?: string; code?: string; cancelled?: boolean }
export function DefaultSettings({ connection, models, onboarding, onComplete, onBack, onModels }: { connection: ConnectionSummary; models: ConnectionModels | null; onboarding?: boolean; onComplete: (image: string | null, video: string | null) => Promise<void>; onBack?: () => void; onModels?: (value:ConnectionModels)=>void }) {
  const [image, setImage] = useState(defaultModel(connection,models,'image'));
  const [video, setVideo] = useState(defaultModel(connection,models,'video'));
  const edited = useRef({image:false,video:false});
  useEffect(()=>{if(!models?.displaySettings)return;if(!edited.current.image)setImage(defaultModel(connection,models,'image'));if(!edited.current.video)setVideo(defaultModel(connection,models,'video'));},[models?.displaySettings,connection]);
  const [directory, setDirectory] = useState<OutputDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [observedAt] = useState(() => Date.now());
  useUpdateBlocker(() => busy || image !== defaultModel(connection,models,'image') || video !== defaultModel(connection,models,'video'));
  useEffect(() => { let active = true; void window.novaDesktop?.getOutputDirectory().then(result => { if (active) { if (!result.ok) setDirectoryError(localErrorMessage(Error(result.code))); else setDirectory(result); } }).catch(() => { if (active) setDirectoryError('读取保存目录失败，请重试。'); }); return () => { active = false; }; }, []);
  async function choose() {
    setBusy(true); setDirectoryError('');
    try { const result = await window.novaDesktop?.chooseOutputDirectory(); if (!result?.ok) throw Error(result?.code); if (!result.cancelled) setDirectory(result); }
    catch (e) { setDirectoryError(localErrorMessage(e)); }
    finally { setBusy(false); }
  }
  async function complete() {
    setBusy(true); setError(''); setDirectoryError('');
    try {
      const result = await window.novaDesktop?.checkOutputDirectory();
      if (!result?.ok) { setDirectoryError(localErrorMessage(Error(result?.code))); return; }
      setDirectory(result); await onComplete(image || null, video || null);
    } catch (e) { setError(localErrorMessage(e)); }
    finally { setBusy(false); }
  }
  const visibleModels = models?.models.filter(item => item.visibility === 'visible').map(item => item.model) || [];
  function modelField(label: string, value: string, set: (value: string) => void, fallback: string) {
    const item = models?.models.find(item => item.model === value);
    const absent = Boolean(models?.modelsFetchedAt && !visibleModels.includes(value) && !item?.custom);
    if (models?.displaySettings) {
      const kind=label==='图片默认模型'?'image':'video', permitted=models.displaySettings[kind==='image'?'imageModels':'videoModels'];
      const options=classifiedModels(models,kind).filter(item=>item.visibility==='visible' && modelSubmissionEnabled(item,kind) && (models.displaySettings!.revision===0 || permitted.includes(item.model)));
      return <div><label>{label}<select value={options.some(item=>item.model===value)?value:''} onChange={event=>{edited.current[kind]=true;set(event.target.value);}}><option value="" disabled={options.length>0}>{options.length ? '请选择已接入型号' : '暂无已接入型号，可稍后设置'}</option>{options.map(item=><option key={item.model} value={item.model}>{item.model}</option>)}</select></label><p className="wb-help">默认型号必须为当前连接中已显示且已接入的型号，仅用于新草稿。</p></div>;
    }
    return <div><label>{label}<input value={value} onChange={event => {edited.current[label==='图片默认模型'?'image':'video']=true;set(event.target.value);}} list={label === '图片默认模型' ? 'wb-image-models' : 'wb-video-models'} maxLength={200} autoComplete="off" /></label><datalist id={label === '图片默认模型' ? 'wb-image-models' : 'wb-video-models'}>{modelOptions(models,label==='图片默认模型'?'image':'video',value).map(name => <option key={name} value={name} />)}</datalist><p className={absent ? 'wb-warning' : 'wb-help'}>{absent ? `当前模型列表缺少 ${value}；保留该完整型号，相关生成暂不可用。请明确选择替代型号，应用不会自动替换。` : item?.visibility === 'visible' ? '列表中可见；具体模式和规格仍需独立能力证据。' : '型号可保存为待验证；没有模型列表或能力证据时不会启用生成。'}</p></div>;
  }
  const validModel = (value:string,kind:'image'|'video') => models?.displaySettings ? !value || classifiedModels(models,kind).some(item=>item.model===value && item.visibility==='visible' && modelSubmissionEnabled(item,kind) && (models.displaySettings!.revision===0 || models.displaySettings![kind==='image'?'imageModels':'videoModels'].includes(value))) : /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
  return <section className="wb-form" aria-label="默认模型与保存位置"><h2>{onboarding ? '选择默认项，开始创作' : '默认模型与保存位置'}</h2><p className="wb-help">默认项仅用于新草稿与新任务；已有草稿、任务快照和结果目录保持原记录。</p>
    <details className="wb-model-cache"><summary>模型列表与能力说明</summary><p className="wb-help">模型缓存时间：{models?.modelsFetchedAt ? new Date(models.modelsFetchedAt).toLocaleString('zh-CN') : '尚未获取'}。{connection.validationState !== 'verified' || !models?.modelsFetchedAt || observedAt - Date.parse(models.modelsFetchedAt) > 600000 ? '当前列表可能过期，仅供参考，请重新检查连接。' : '仅表示最近只读检查时的可见性。'}</p><ul>{models?.models.map(item => <li key={item.model}>{item.model}<span>{item.visibility === 'visible' ? '缓存中可见' : item.visibility === 'absent' ? '列表未找到' : '尚未核对'}</span></li>)}</ul><p className="wb-help">生成能力按服务、完整型号、模式、协议与规格分别验证。历史双图参考证据不代表本应用已完成真实生成验收；其他未验证组合不会因列表可见而启用。</p></details>
    {modelField('图片默认模型', image, setImage, PRESET_MODELS[0])}{modelField('视频默认模型', video, setVideo, PRESET_MODELS[2])}
    <div className="wb-directory"><div><span className="wb-label">作品保存位置</span><p>{directory?.displayName || '正在读取本机目录…'}</p><p className="wb-help">本机受管目录 · 选择后验证可写并立即应用于新任务。已有文件不自动搬迁。</p></div><button type="button" disabled={busy} onClick={() => void choose()}>选择文件夹</button></div>
    {directoryError && <p role="alert" className="wb-error">{directoryError}</p>}{error && <p role="alert" className="wb-error">{error}</p>}
    <ModelCatalogSettings connection={connection} models={models} onModels={onModels} />
    <div className="wb-actions">{onBack && <button type="button" disabled={busy} onClick={onBack}>上一步</button>}<button type="button" className="wb-primary" disabled={busy || !directory || !validModel(image,'image') || !validModel(video,'video')} onClick={() => void complete()}>{busy ? '检查目录并保存…' : onboarding ? '进入工作台' : '保存默认项'}</button></div>
  </section>;
}

export function ModelCatalogSettings({connection,models,onModels,expanded=false}:{connection:ConnectionSummary;models:ConnectionModels|null;onModels?: (value:ConnectionModels)=>void;expanded?:boolean}) {
  const [name,setName]=useState(''),[categories,setCategories]=useState<string[]>([]),[custom,setCustom]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useUpdateBlocker(()=>busy);
  async function refresh(){setBusy(true);setNotice('');try{const result=await checkConnection(connection,true,'manual');if(result.stale)throw Error('CONNECTION_VERSION_CONFLICT');if(result.models)onModels?.(result as ConnectionModels);setNotice(result.connection?.validationState==='verified'?'模型列表已更新。':'刷新未成功，保留上次清单。');}catch{setNotice('刷新失败，保留上次清单。');}finally{setBusy(false);}}
  async function save(reset=false){setBusy(true);setNotice('');try{onModels?.(await saveModelSettings(connection,{model:name,categories:reset?null:categories,custom:reset?false:custom}));setNotice('已保存当前连接的型号设置；分类不会自动接通生成能力。');}catch{setNotice('保存失败，请核对型号或重新读取连接。');}finally{setBusy(false);}}
  return <details open={expanded || undefined}><summary>模型分类与自定义型号</summary><button type="button" disabled={busy} onClick={()=>void refresh()}>刷新模型列表</button>{models?.refreshError&&<p className="wb-warning">最近刷新未成功，当前使用上次模型清单。</p>}<p className="wb-help">未分类型号不会混入生成列表。手动指定类别不代表此型号已接入生成协议。</p><label>选择已有型号<select value={name} onChange={event=>{const model=event.target.value,item=models?.models.find(item=>item.model===model);setName(model);setCategories(item?.categories||[]);setCustom(item?.custom||false);}}><option value="">选择或在下方填写</option>{models?.models.map(item=><option key={item.model} value={item.model}>{item.model}{!item.categories?.length?' · 未分类':''}</option>)}</select></label><label>完整型号<input value={name} maxLength={200} autoComplete="off" onChange={event=>{setName(event.target.value);setCategories([]);setCustom(false);}} /></label><div>{[['image','图片'],['video','视频']].map(([value,label])=><label key={value}><input type="checkbox" checked={categories.includes(value)} onChange={event=>setCategories(previous=>event.target.checked?[...previous,value]:previous.filter(item=>item!==value))} />{label}</label>)}</div><label><input type="checkbox" checked={custom} onChange={event=>setCustom(event.target.checked)} />显式添加为未列出型号（仍需已有生成适配）</label><div className="wb-actions"><button type="button" disabled={busy||!name} onClick={()=>void save()}>保存分类</button><button type="button" disabled={busy||!name} onClick={()=>void save(true)}>恢复自动分类</button></div>{notice&&<p role="status">{notice}</p>}</details>;
}

export function OutputDirectorySettings() {
  const [directory,setDirectory]=useState<OutputDirectory|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useUpdateBlocker(()=>busy);
  useEffect(()=>{let active=true;void window.novaDesktop?.getOutputDirectory().then(value=>{if(active){if(!value.ok)setError(localErrorMessage(Error(value.code)));else setDirectory(value);}}).catch(()=>{if(active)setError('读取保存目录失败，请重试。');});return()=>{active=false;};},[]);
  async function choose(){setBusy(true);setError('');try{const value=await window.novaDesktop?.chooseOutputDirectory();if(!value?.ok)throw Error(value?.code);if(!value.cancelled)setDirectory(value);}catch(error){setError(localErrorMessage(error));}finally{setBusy(false);}}
  return <section className="wb-panel"><h2>作品存储</h2><div className="wb-directory"><div><span className="wb-label">作品保存位置</span><p>{directory?.displayName || '正在读取本机目录…'}</p><p className="wb-help">本机受管目录 · 选择后验证可写并立即应用于新任务。已有文件不自动搬迁。</p></div><button type="button" disabled={busy} onClick={()=>void choose()}>选择文件夹</button></div>{error&&<p role="alert" className="wb-error">{error}</p>}</section>;
}
