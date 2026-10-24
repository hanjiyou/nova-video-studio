'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Sparkles, X } from 'lucide-react';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import type { AssetSummary } from '@/lib/workbench-task-client';
import { Draft, DraftMode, importReference, localErrorMessage, PRESET_MODELS } from '@/lib/workbench-client';
import { generationPlan, generationEvidenceVerified } from '@/lib/workbench-generation';
import { useWorkbenchPanelHeight } from '@/hooks/useWorkbenchPanelHeight';
function videoRatio(size: string) { const [width,height] = size.split('x').map(Number); if (!width || !height) return ''; let a = width, b = height; while (b) [a,b] = [b,a % b]; return `${width/a}:${height/a}`; }
export function DraftEditor({ draft, connection, models, saving, error, onChange, onConfigure, onRetry, onReload, onSubmit, submitting = false, submitDisabled = false, onChooseLibrary }: { draft: Draft; connection: ConnectionSummary | null; models: ConnectionModels | null; saving: boolean; error?: unknown; onChange: (patch: Partial<Draft>) => void; onConfigure: () => void; onRetry: () => void; onReload: () => void; onSubmit?: () => void; submitting?: boolean; submitDisabled?: boolean; onChooseLibrary?: () => void }) {
  const [importing, setImporting] = useState(false), [importError, setImportError] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const panel = useWorkbenchPanelHeight();
  const importBusy = useRef(false);
  const image = draft.mode === 'image.text', count = draft.mode === 'video.dual_reference' ? 2 : 1;
  const refs = useRef(draft.inputAssets); useEffect(() => { refs.current = draft.inputAssets; }, [draft.inputAssets]);
  const referenceMode = image || draft.mode !== 'video.text';
  const plan = generationPlan(draft, connection, models), selectedModel = plan.model, capability = plan.capability;
  const visibility = models?.models.find(item => item.model === selectedModel)?.visibility;
  const capabilityText = !connection ? '连接后选择模型。预设名称仅供参考，尚未核对账户权限。' : visibility === 'absent' ? '该完整型号不在当前模型列表中，未自动换成其他型号。' : capability?.evidenceLevel === 'application_verified' && generationEvidenceVerified(capability) ? '当前服务、完整型号和此模式已通过本应用真实生成与本地媒体验证。' : capability?.evidenceLevel === 'historically_verified' ? '当前服务、完整型号和模式有历史协议证据；此版本尚无本应用实测登记。' : '当前模型与模式尚未验证；保留显示，暂不开放提交。';
  async function imports(files?: FileList | File[]) {
    if (importBusy.current) return;
    importBusy.current = true;
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
    finally { importBusy.current = false; setImporting(false); if (input.current) input.current.value = ''; }
  }
  function move(index: number, direction: number) { const assets = [...draft.inputAssets]; [assets[index], assets[index + direction]] = [assets[index + direction], assets[index]]; onChange({ inputAssets: assets }); }
  function reorder(from: number, to: number) { if (!Number.isInteger(from) || from < 0 || from >= refs.current.length || from === to) return; const assets = [...refs.current]; assets.splice(to, 0, assets.splice(from, 1)[0]); onChange({ inputAssets: assets }); }
  const ratio = (size: string) => { const [w,h] = size.split('x').map(Number); return w === h ? 'square' : w > h ? 'landscape' : 'portrait'; };
  const setParameter = (key: string, value: string) => { const parameters = { ...draft.parameters }; if (value) parameters[key] = value; else delete parameters[key]; onChange({ parameters }); };
  return <section ref={panel} className="wb-panel wb-editor" aria-label={image ? '图片草稿' : '视频草稿'}>
    <div className="wb-section-heading"><h2>创作参数</h2><span className={error ? 'wb-error' : 'wb-help'} aria-live="polite">{error ? '草稿未保存' : saving ? '正在保存草稿…' : '草稿已保存到本机'}</span></div>
    <label>生成模型<select value={selectedModel} onChange={event => onChange({ model: event.target.value })}>{[...new Set([selectedModel, ...(image ? [PRESET_MODELS[0]] : [PRESET_MODELS[2], PRESET_MODELS[1]]), ...(models?.models.filter(item => item.visibility === 'visible').map(item => item.model) || [])])].map(name => <option key={name} value={name}>{name}{!connection ? ' · 待配置' : models?.models.find(item => item.model === name)?.visibility !== 'visible' ? ' · 未确认可见' : ''}</option>)}</select></label>
    <p className="wb-help">{capabilityText}</p>
    {image && <div className="wb-image-parameters"><div className="wb-specs" role="group" aria-label="画面比例">{[['landscape','横版'],['square','方形'],['portrait','竖版']].map(([value,label]) => <button type="button" key={value} aria-pressed={Boolean(draft.parameters.size && ratio(String(draft.parameters.size)) === value)} disabled={!plan.sizes.some(size => ratio(size) === value)} onClick={() => setParameter('size', plan.sizes.find(size => ratio(size) === value)!)}>{label}</button>)}</div><div className="wb-parameter-grid"><label>图片尺寸<select value={String(draft.parameters.size || '')} disabled={!plan.sizes.length} onChange={event => setParameter('size',event.target.value)}><option value="">服务自动</option>{[...new Set([...plan.sizes,...(draft.parameters.size ? [String(draft.parameters.size)] : [])])].map(size => <option key={size} value={size}>{size}{!plan.sizes.includes(size) ? ' · 待验证' : ''}</option>)}</select></label><label>图片质量<select value={String(draft.parameters.quality || '')} disabled={!plan.qualities.length} onChange={event => setParameter('quality',event.target.value)}><option value="">自动</option>{[...new Set([...plan.qualities,...(draft.parameters.quality ? [String(draft.parameters.quality)] : [])])].map(quality => <option key={quality}>{quality}</option>)}</select></label></div>{!plan.sizes.length && <p className="wb-help">当前型号的尺寸、比例与质量缺少精确成功证据，暂由服务自动决定；没有开放猜测的规格。</p>}</div>}
    {referenceMode && <div className="wb-references" onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!importing && event.dataTransfer.files.length) void imports(event.dataTransfer.files); }}><div className="wb-section-heading"><h3>参考图片{image ? '（可选）' : ''}</h3><span>{draft.inputAssets.length} / {count}</span></div><div className="wb-reference-grid">{draft.inputAssets.map((asset, index) => <div className="wb-reference" key={asset.assetId + '-' + index} draggable={count === 2} onDragStart={event => { event.dataTransfer.setData('application/x-nova-reference-index', String(index)); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => event.preventDefault()} onDrop={event => { const value = event.dataTransfer.getData('application/x-nova-reference-index'); if (value !== '') { event.preventDefault(); event.stopPropagation(); reorder(Number(value),index); } }}>{asset.availability === 'available' ? <img draggable={false} src={asset.previewUrl} alt={`参考图 ${index + 1}：${asset.displayName}`} /> : <span>文件缺失或损坏</span>}<span className="wb-reference-number">{index + 1}</span><button className="wb-remove" type="button" aria-label={`移除参考图 ${index + 1}`} onClick={() => onChange({ inputAssets: draft.inputAssets.filter((_, position) => position !== index) })}><X size={15} /></button><p>{asset.displayName}</p>{count === 2 && <div className="wb-reference-order"><button type="button" aria-label={`参考图 ${index + 1} 前移`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button type="button" aria-label={`参考图 ${index + 1} 后移`} disabled={index === draft.inputAssets.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div>}</div>)}{draft.inputAssets.length < count && <button type="button" className="wb-upload" disabled={importing} onClick={() => void imports()}><ImagePlus size={24} /><span>{importing ? '正在复制素材…' : '导入参考图'}</span><small>PNG / JPEG · 可拖入</small></button>}</div><input ref={input} type="file" accept="image/png,image/jpeg" multiple={count === 2} hidden onChange={event => { if (event.target.files) void imports(event.target.files); }} />{onChooseLibrary && <button type="button" className="wb-link" onClick={onChooseLibrary}>从作品库选图</button>}<p className="wb-help">导入即复制到本机素材目录。移除只改变草稿引用。{count === 2 && '双图是有序参考，不代表首尾帧锁定。'}</p></div>}
    {importError && <p className="wb-error" role="alert">{importError}</p>}
    <label>{image ? '画面描述' : '剧情描述'}<textarea rows={8} value={draft.prompt} onChange={event => onChange({ prompt: event.target.value })} placeholder={image ? '描述你想创作的画面、光线和氛围…' : '描述镜头、人物动作与对白…'} /></label><p className="wb-character-count">{draft.prompt.length} 字</p>
    {!image && <div className="wb-specs" aria-label="视频规格">{generationEvidenceVerified(capability) && typeof capability?.parameters.seconds === 'number' && typeof capability?.parameters.size === 'string' ? <><span>{capability.parameters.seconds} 秒 · 固定</span><span>{videoRatio(capability.parameters.size)}</span><span>{capability.parameters.size.replace('x',' × ')}</span><small>当前能力记录的固定规格</small></> : <small>此组合的规格尚未验证</small>}</div>}
    {Boolean(error) && <div role="alert" className="wb-error">{localErrorMessage(error)}<button type="button" onClick={onRetry}>重试保存</button><button type="button" onClick={onReload}>重新读取本机草稿（放弃未保存修改）</button></div>}
    <div className="wb-editor-footer"><p className="wb-help" aria-live="polite">{plan.blocked || '点击后加入本地队列；派发会调用配置的生成服务，可能产生费用。'}</p>{!connection?.hasCredential ? <button type="button" className="wb-primary" onClick={onConfigure}><Sparkles size={17} />配置连接后生成</button> : <button type="button" className="wb-primary" disabled={Boolean(plan.blocked || saving || error || importing || submitting || submitDisabled || !onSubmit)} onClick={onSubmit}><Sparkles size={17} />{submitting ? '正在建立本地任务…' : image ? '生成图片' : '生成视频'}</button>}</div>
  </section>;
}
export const VIDEO_MODES: Array<{ mode: DraftMode; title: string }> = [{ mode: 'video.text', title: '文生视频' }, { mode: 'video.single_reference', title: '单图生视频' }, { mode: 'video.dual_reference', title: '双图参考' }];
