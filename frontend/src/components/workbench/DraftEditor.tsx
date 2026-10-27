'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Info, Sparkles, X } from 'lucide-react';
import { modelOptions, videoRule,videoDefaults,validVideoParameters,videoPrice } from '@/lib/workbench-model-catalog';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import type { AssetSummary } from '@/lib/workbench-task-client';
import { Draft, DraftMode, importReference, localErrorMessage } from '@/lib/workbench-client';
import { generationPlan, generationEvidenceVerified } from '@/lib/workbench-generation';
import { MAX_VIDEO_REFERENCE_ASSETS } from '@/lib/reference-policy';
import { IMAGE_QUALITY_LABELS } from '@/lib/image-policy';
import { ImagePrice } from './ImagePrice';
import { VideoDurationControl } from './VideoDurationControl';
import { useWorkbenchPanelHeight } from '@/hooks/useWorkbenchPanelHeight';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';

function videoRatio(size: string) { const [width,height] = size.split('x').map(Number); if (!width || !height) return ''; let a = width, b = height; while (b) [a,b] = [b,a % b]; return `${width/a}:${height/a}`; }
export interface SubmitBlocker { code: string; message: string; actionLabel?: string; onAction?: () => void }
export function DraftEditor({ draft, connection, models, saving, error, onChange, onConfigure, onRetry, onReload, onSubmit, submitting = false, submitDisabled = false, submitBlockers, onChooseLibrary, onModels, onImportBusyChange }: { draft: Draft; connection: ConnectionSummary | null; models: ConnectionModels | null; saving: boolean; error?: unknown; onChange: (patch: Partial<Draft>) => void; onConfigure: () => void; onRetry: () => void; onReload: () => void; onSubmit?: () => void; submitting?: boolean; submitDisabled?: boolean; submitBlockers?: SubmitBlocker[]; onChooseLibrary?: () => void; onModels?: (value:ConnectionModels)=>void; onImportBusyChange?: (busy: boolean) => void }) {
  const [parameterNotice,setParameterNotice]=useState('');
  const [importing, setImporting] = useState(false), [importError, setImportError] = useState('');
  const input = useRef<HTMLInputElement | null>(null), durationInput = useRef<HTMLInputElement | null>(null);
  const promptInput = useRef<HTMLTextAreaElement | null>(null), modelInput = useRef<HTMLSelectElement | null>(null);
  const referencesPanel = useRef<HTMLDivElement | null>(null), parametersPanel = useRef<HTMLDivElement | null>(null), saveError = useRef<HTMLDivElement | null>(null);
  const reasonsId = useId();
  const panel = useWorkbenchPanelHeight();
  const importBusy = useRef(false);
  useUpdateBlocker(() => importBusy.current);
  const image = draft.mode === 'image.text', multiDraft = draft.mode === 'video.dual_reference', count = draft.mode === 'video.text' ? 0 : multiDraft ? MAX_VIDEO_REFERENCE_ASSETS : 1;
  const refs = useRef(draft.inputAssets); useEffect(() => { refs.current = draft.inputAssets; }, [draft.inputAssets]);
  const referenceMode = image || draft.mode !== 'video.text' || draft.inputAssets.length > 0;
  const plan = generationPlan(draft, connection, models), selectedModel = plan.model, capability = plan.capability;
  const visibility = models?.models.find(item => item.model === selectedModel)?.visibility;
  const capabilityText = plan.videoConfiguration ? (visibility==='absent'&&!models?.models.find(item=>item.model===selectedModel)?.custom?'当前服务未列出，可能暂时不可用；参数已保留。':plan.rule?.submissionEnabled?'当前规格按配置提交，部分秒数与带图省略尺寸尚待真实验证。':'此型号的参数配置已准备，生成协议与规格仍待验证。') : plan.unverifiedImage ? '图片规格与参考图编辑尚未在当前中转实测。点击生成可能失败或计费。' : plan.unverifiedMulti ? '三张及以上有序参考尚未真实实测，供应商数量上限未知；点击生成会按当前顺序提交，可能失败或计费。' : !connection ? '连接后选择模型。预设名称仅供参考，尚未核对账户权限。' : visibility === 'absent' ? '该完整型号不在当前模型列表中，未自动换成其他型号。' : capability?.evidenceLevel === 'application_verified' && generationEvidenceVerified(capability) ? '当前服务、完整型号和此模式已通过本应用真实生成与本地媒体验证。' : capability?.evidenceLevel === 'historically_verified' ? '当前服务、完整型号和模式有历史协议证据；此版本尚无本应用实测登记。' : '当前模型与模式尚未验证；保留显示，暂不开放提交。';
  async function imports(files?: FileList | File[]) {
    if (importBusy.current) return;
    importBusy.current = true; onImportBusyChange?.(true);
    setImporting(true); setImportError('');
    try {
      let assets: AssetSummary[];
      if (files) {
        const selected = Array.from(files);
        if (!selected.length) return;
        if (selected.some(file => !['image/png', 'image/jpeg'].includes(file.type))) throw Error('ASSET_TYPE_INVALID');
        if (selected.length + refs.current.length > count) { setImportError(`此草稿最多使用 ${count} 张参考图；未导入或移除任何图片。`); return; }
        assets = []; for (const file of selected) assets.push(await importReference(file));
      } else {
        const result = await window.novaDesktop?.importReferenceAssets();
        if (!result?.ok) throw Error(result?.code);
        if (result.cancelled) return;
        assets = (result.assets || []) as AssetSummary[];
      }
      if (assets.length + refs.current.length > count) { setImportError(`选图超过此草稿的 ${count} 张范围。原图已复制到受管素材目录，本次没有替换草稿引用。`); return; }
      onChange({ inputAssets: [...refs.current, ...assets] });
    } catch (e) { setImportError(localErrorMessage(e)); }
    finally { importBusy.current = false; onImportBusyChange?.(false); setImporting(false); if (input.current) input.current.value = ''; }
  }
  function focus(element: HTMLElement | null) { element?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); element?.focus(); }
  function chooseReferences() {
    if (importBusy.current) return;
    if (window.novaDesktop?.importReferenceAssets) void imports();
    else input.current?.click();
  }
  const waiting = saving || importing || submitting;
  const blockers: SubmitBlocker[] = plan.issues.map(issue => {
    const action = issue.action === 'configure' ? { actionLabel: '配置连接', onAction: onConfigure } :
      issue.action === 'model' ? { actionLabel: '检查型号', onAction: () => focus(modelInput.current) } :
      issue.action === 'prompt' ? { actionLabel: '去填写', onAction: () => focus(promptInput.current) } :
      issue.action === 'add-references' ? { actionLabel: draft.inputAssets.length ? '继续添加' : '添加参考图', onAction: chooseReferences } :
      issue.action === 'review-references' ? { actionLabel: '查看参考图', onAction: () => focus(referencesPanel.current) } :
      issue.action === 'duration' ? { actionLabel: '调整时长', onAction: () => focus(durationInput.current) } :
      issue.action === 'parameters' ? { actionLabel: '核对参数', onAction: () => focus(parametersPanel.current) } : {};
    return { code: issue.code, message: issue.message, ...action };
  });
  if (saving) blockers.push({ code: 'saving', message: '正在保存草稿，完成后可生成。' });
  if (error) blockers.push({ code: 'save-error', message: '草稿尚未保存成功，请先处理保存问题。', actionLabel: '查看保存问题', onAction: () => focus(saveError.current) });
  if (importing) blockers.push({ code: 'importing', message: '正在导入参考图，完成后可生成。' });
  if (submitting) blockers.push({ code: 'submitting', message: '正在建立本地任务，请稍候。' });
  if (submitDisabled) blockers.push(...(submitBlockers?.length ? submitBlockers : [{ code: 'submit-disabled', message: '当前暂不能提交，请先核对本地任务状态。' }]));
  if (!onSubmit) blockers.push({ code: 'submit-unavailable', message: '生成入口尚未就绪，请稍后再试。' });
  const generationDisabled = blockers.length > 0;
  function move(index: number, direction: number) { const assets = [...draft.inputAssets]; [assets[index], assets[index + direction]] = [assets[index + direction], assets[index]]; onChange({ inputAssets: assets }); }
  function reorder(from: number, to: number) { if (!Number.isInteger(from) || from < 0 || from >= refs.current.length || from === to) return; const assets = [...refs.current]; assets.splice(to, 0, assets.splice(from, 1)[0]); onChange({ inputAssets: assets }); }
  const ratio = (size: string) => { const [w,h] = size.split('x').map(Number); return w === h ? 'square' : w > h ? 'landscape' : 'portrait'; };
  const setParameter = (key: string, value: string) => { const parameters = { ...draft.parameters }; if (value) parameters[key] = value; else delete parameters[key]; onChange({ parameters }); };
  return <section ref={panel} className="wb-panel wb-editor" aria-label={image ? '图片草稿' : '视频草稿'}>
    <div className="wb-section-heading"><h2>创作参数</h2><span className={error ? 'wb-error' : 'wb-help'} aria-live="polite">{error ? '草稿未保存' : saving ? '正在保存草稿…' : '草稿已保存到本机'}</span></div>
    <label>生成模型<select ref={modelInput} value={selectedModel} onChange={event => {
      const model=event.target.value,rule=videoRule(model,connection);
      if(!image && rule) {const parameters={...plan.parameters}; if(!rule.sendSize)delete parameters.size;else if(!parameters.size)parameters.size=rule.defaultSize || rule.sizes[0];
        const valid=validVideoParameters(rule,parameters);onChange({model,parameters:valid?parameters:videoDefaults(model,rule,models)});setParameterNotice(valid?'已按所选型号更新参数规则。':'原参数不适用于此型号，已使用该型号默认参数。');
      } else onChange({model});
    }}>{modelOptions(models,image?'image':'video',selectedModel).map(name => {const item=models?.models.find(item=>item.model===name);return <option key={name} value={name}>{name}{item?.visibility==='absent'&&!item.custom?' · 当前未列出':item?.custom&&item.visibility!=='visible'?' · 手动添加':!connection?' · 待配置':''}</option>;})}</select></label>
    <p className={plan.unverifiedMulti || plan.unverifiedImage ? "wb-warning" : "wb-help"}>{capabilityText}</p>
    {image && <div ref={parametersPanel} tabIndex={-1} className="wb-image-parameters"><div className="wb-specs" role="group" aria-label="画面比例">{[['landscape','横版'],['square','方形'],['portrait','竖版']].map(([value,label]) => <button type="button" key={value} aria-pressed={Boolean(draft.parameters.size && ratio(String(draft.parameters.size)) === value)} disabled={!plan.sizes.some(size => ratio(size) === value)} onClick={() => setParameter('size', plan.sizes.find(size => ratio(size) === value)!)}>{label}</button>)}</div><div className="wb-parameter-grid"><label>图片尺寸<select value={String(draft.parameters.size || '')} disabled={!plan.sizes.length} onChange={event => setParameter('size',event.target.value)}><option value="">服务自动</option>{[...new Set([...plan.sizes,...(draft.parameters.size ? [String(draft.parameters.size)] : [])])].map(size => <option key={size} value={size}>{size}{!plan.sizes.includes(size) ? ' · 待验证' : ''}</option>)}</select></label><label>图片质量<select value={String(draft.parameters.quality || '')} disabled={!plan.qualities.length} onChange={event => setParameter('quality',event.target.value)}><option value="">自动</option>{[...new Set([...plan.qualities,...(draft.parameters.quality ? [String(draft.parameters.quality)] : [])])].map(quality => <option key={quality} value={quality}>{IMAGE_QUALITY_LABELS[quality] || quality}</option>)}</select></label></div>{plan.sizes.length ? <p className="wb-help">横版 3:2 · 方形 1:1 · 竖版 2:3；自动由模型决定。</p> : <p className="wb-help">当前模型暂不提供尺寸和质量选项。</p>}</div>}
    {referenceMode && <div ref={referencesPanel} tabIndex={-1} aria-label="参考图片区域" className="wb-references" onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!importing && event.dataTransfer.files.length) void imports(event.dataTransfer.files); }}><div className="wb-section-heading"><h3>参考图片{image ? '（可选）' : ''}</h3><span>{draft.inputAssets.length} / {count}</span></div><div className="wb-reference-grid">{draft.inputAssets.map((asset, index) => <div className="wb-reference" key={asset.assetId + '-' + index} draggable={multiDraft} onDragStart={event => { event.dataTransfer.setData('application/x-nova-reference-index', String(index)); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => event.preventDefault()} onDrop={event => { const value = event.dataTransfer.getData('application/x-nova-reference-index'); if (value !== '') { event.preventDefault(); event.stopPropagation(); reorder(Number(value),index); } }}>{asset.availability === 'available' ? <img draggable={false} src={asset.previewUrl} alt={`参考图 ${index + 1}：${asset.displayName}`} /> : <span>文件缺失或损坏</span>}<span className="wb-reference-number">{index + 1}</span><button className="wb-remove" type="button" aria-label={`移除参考图 ${index + 1}`} onClick={() => onChange({ inputAssets: draft.inputAssets.filter((_, position) => position !== index) })}><X size={15} /></button><p>{asset.displayName}</p>{multiDraft && <div className="wb-reference-order"><button type="button" aria-label={`参考图 ${index + 1} 前移`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button type="button" aria-label={`参考图 ${index + 1} 后移`} disabled={index === draft.inputAssets.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div>}</div>)}{draft.inputAssets.length < count && <button type="button" className="wb-upload" disabled={importing} onClick={chooseReferences}><ImagePlus size={24} /><span>{importing ? '正在复制素材…' : '导入参考图'}</span><small>PNG / JPEG · 可拖入</small></button>}</div><input ref={input} type="file" accept="image/png,image/jpeg" multiple={multiDraft} hidden onChange={event => { if (event.target.files) void imports(event.target.files); }} />{onChooseLibrary && <button type="button" className="wb-link" onClick={onChooseLibrary}>从作品库选图</button>}<p className="wb-help">导入即复制到本机素材目录。移除只改变草稿引用。{image && '添加图片后，描述你想修改的内容。'}{multiDraft && `多图按显示顺序参考，不代表首尾帧锁定。本应用一次最多添加 ${MAX_VIDEO_REFERENCE_ASSETS} 张，服务实际支持数量待确认。`}</p></div>}
    {importError && <p className="wb-error" role="alert">{importError}</p>}
    <label>{image ? '画面描述' : '剧情描述'}<textarea ref={promptInput} rows={8} value={draft.prompt} onChange={event => onChange({ prompt: event.target.value })} placeholder={image ? '描述你想创作的画面、光线和氛围…' : '描述镜头、人物动作与对白…'} /></label><p className="wb-character-count">{draft.prompt.length} 字</p>
    {!image && (plan.rule && plan.videoConfiguration ? <div ref={parametersPanel} tabIndex={-1} className="wb-video-parameters">
      <VideoDurationControl key={JSON.stringify([connection?.connectionId,connection?.connectionVersionId,connection?.provider,connection?.baseUrl,connection?.route,connection?.routeRevision,selectedModel])} connection={connection} model={selectedModel} rule={plan.rule} models={models} seconds={plan.parameters.seconds} inputRef={durationInput} onChange={seconds => onChange({parameters:{...plan.parameters,seconds}})} onModels={onModels} />
      <p className="wb-help">直接输入 {plan.rule.minSeconds}～{plan.rule.maxSeconds} 的整数秒。</p>
      {plan.rule.sendSize ? <><label>画面尺寸<select aria-label="视频画面尺寸" value={plan.rule.sizes.includes(String(plan.parameters.size))?String(plan.parameters.size):'custom'} onChange={event=>{if(event.target.value==='custom')onChange({parameters:{...plan.parameters,size:'x'}});else onChange({parameters:{...plan.parameters,size:event.target.value}});}}>{plan.rule.sizes.map(size=><option key={size} value={size}>{size.replace('x',' × ')}</option>)}<option value="custom">自定义宽高</option></select></label>{!plan.rule.sizes.includes(String(plan.parameters.size))&&<div className="wb-parameter-grid">{['宽度','高度'].map((label,index)=><label key={label}>{label}<input type="number" min="1" step="1" value={String(plan.parameters.size||'x').split('x')[index]||''} onChange={event=>{const dimensions=String(plan.parameters.size||'x').split('x');dimensions[index]=event.target.value;onChange({parameters:{...plan.parameters,size:dimensions.join('x')}});}} /></label>)}</div>}<p className="wb-help">候选尺寸，服务支持范围仍待验证。</p></>:<p className="wb-help">尺寸由服务决定，不传尺寸参数。{Object.hasOwn(plan.parameters,'size')&&<button type="button" onClick={()=>{const parameters={...plan.parameters};delete parameters.size;onChange({parameters});setParameterNotice('已移除旧草稿的尺寸参数。');}}>移除旧尺寸参数</button>}</p>}
      {!validVideoParameters(plan.rule,plan.parameters)&&<p role="alert" className="wb-error">请输入有效的整数秒数{plan.rule.sendSize?'和正整数宽高':''}。</p>}
      {parameterNotice&&<p role="status" className="wb-help">{parameterNotice}</p>}
    </div>:<div ref={parametersPanel} tabIndex={-1} className="wb-specs" aria-label="视频规格">{plan.unverifiedMulti ? <><span>6 秒 · 尝试参数</span><span>1280 × 720 · 请求参数</span><small>3张及以上尚未实测，能否生成以服务返回结果为准。</small></> : generationEvidenceVerified(capability) && typeof capability?.parameters.seconds === 'number' ? <><span>{capability.parameters.seconds} 秒 · 固定</span>{typeof capability.parameters.size === 'string' ? <><span>{videoRatio(capability.parameters.size)}</span><span>{capability.parameters.size.replace('x',' × ')}</span><small>当前能力记录的固定规格</small></> : <><span>分辨率由服务决定</span><small>不传尺寸参数</small>{Object.hasOwn(draft.parameters,'size') && <button type="button" onClick={() => { const parameters = { ...draft.parameters }; delete parameters.size; onChange({ parameters }); }}>使用服务默认分辨率</button>}</>}</> : <small>此组合的规格尚未验证</small>}</div>)}
    {Boolean(error) && <div ref={saveError} tabIndex={-1} role="alert" className="wb-error">{localErrorMessage(error)}<button type="button" onClick={onRetry}>重试保存</button><button type="button" onClick={onReload}>重新读取本机草稿（放弃未保存修改）</button></div>}
    {image ? <ImagePrice connection={connection} model={selectedModel} models={models} /> : <div className="wb-generation-price" aria-live="polite"><span>本次预计费用</span><strong>{videoPrice(plan.rule,plan.parameters.seconds)!==null?'¥'+videoPrice(plan.rule,plan.parameters.seconds):plan.rule?'请输入有效时长':'暂无法估算'}</strong>{plan.rule&&videoPrice(plan.rule,plan.parameters.seconds)!==null&&<small>{String(plan.parameters.seconds)} 秒 × ¥{(plan.rule.centsPerSecond/100).toFixed(2)}/秒</small>}<small>按配置单价估算，实际扣费以中转结算为准。</small></div>}
    <div className="wb-editor-footer">
      {generationDisabled ? <div id={reasonsId} className="wb-generation-guidance" aria-live="polite" aria-label="生成条件"><div className="wb-guidance-title"><Info size={16} aria-hidden="true" /><span>{waiting ? '正在处理，请稍候' : '生成前还需完成'}</span></div><ul>{blockers.map((item, index) => <li key={item.code + '-' + index}><span>{item.message}</span>{!waiting && item.onAction && <button type="button" className="wb-guidance-action" onClick={item.onAction}>{item.actionLabel}</button>}</li>)}</ul></div> : <p className="wb-help">点击后加入本地队列；派发会调用配置的生成服务，可能产生费用。</p>}
      {!connection?.hasCredential ? <button type="button" className="wb-primary" onClick={onConfigure}><Sparkles size={17} />配置连接后生成</button> : <button type="button" className="wb-primary" aria-describedby={generationDisabled ? reasonsId : undefined} disabled={generationDisabled} onClick={() => { if (!generationDisabled) onSubmit?.(); }}><Sparkles size={17} />{submitting ? '正在建立本地任务…' : image ? '生成图片' : '生成视频'}</button>}
    </div>
  </section>;
}
export const VIDEO_MODES: Array<{ mode: DraftMode; title: string }> = [{ mode: 'video.text', title: '文生视频' }, { mode: 'video.single_reference', title: '单图生视频' }, { mode: 'video.dual_reference', title: '多图参考' }];
