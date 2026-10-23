'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Sparkles, X } from 'lucide-react';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import type { AssetSummary } from '@/lib/workbench-task-client';
import { Draft, DraftMode, importReference, localErrorMessage, PRESET_MODELS } from '@/lib/workbench-client';
export function DraftEditor({ draft, connection, models, saving, error, onChange, onConfigure, onRetry, onReload }: { draft: Draft; connection: ConnectionSummary | null; models: ConnectionModels | null; saving: boolean; error?: unknown; onChange: (patch: Partial<Draft>) => void; onConfigure: () => void; onRetry: () => void; onReload: () => void }) {
  const [importing, setImporting] = useState(false), [importError, setImportError] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const image = draft.mode === 'image.text', count = draft.mode === 'video.dual_reference' ? 2 : 1;
  const refs = useRef(draft.inputAssets); useEffect(() => { refs.current = draft.inputAssets; }, [draft.inputAssets]);
  const referenceMode = image || draft.mode !== 'video.text';
  const selectedModel = draft.model || (image ? connection?.defaultImageModel : connection?.defaultVideoModel) || (image ? PRESET_MODELS[0] : PRESET_MODELS[2]);
  const mode = image && draft.inputAssets.length ? 'image.reference' : draft.mode;
  const capability = models?.capabilities.find(item => item.model === selectedModel && item.mode === mode);
  const visibility = models?.models.find(item => item.model === selectedModel)?.visibility;
  const capabilityText = !connection ? '连接后选择模型。预设名称仅供参考，尚未核对账户权限。' : visibility === 'absent' ? '该完整型号不在当前模型列表中，未自动换成其他型号。' : capability?.evidenceLevel === 'historically_verified' ? '此服务的 1.5 单/双图组合有历史协议证据；本应用真实生成验收仍待完成。' : '当前模型与模式尚未验证；保留显示，暂不开放提交。';
  async function imports(files?: FileList | File[]) {
    setImporting(true); setImportError('');
    try {
      let assets: AssetSummary[];
      if (files) {
        const selected = Array.from(files);
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
    finally { setImporting(false); if (input.current) input.current.value = ''; }
  }
  function move(index: number, direction: number) { const assets = [...draft.inputAssets]; [assets[index], assets[index + direction]] = [assets[index + direction], assets[index]]; onChange({ inputAssets: assets }); }
  return <section className="wb-panel wb-editor" aria-label={image ? '图片草稿' : '视频草稿'}>
    <div className="wb-section-heading"><h2>创作参数</h2><span className={error ? 'wb-error' : 'wb-help'} aria-live="polite">{error ? '草稿未保存' : saving ? '正在保存草稿…' : '草稿已保存到本机'}</span></div>
    <label>生成模型<select value={selectedModel} onChange={event => onChange({ model: event.target.value })}>{[...new Set([selectedModel, ...(image ? [PRESET_MODELS[0]] : [PRESET_MODELS[2], PRESET_MODELS[1]]), ...(models?.models.filter(item => item.visibility === 'visible').map(item => item.model) || [])])].map(name => <option key={name} value={name}>{name}{!connection ? ' · 待配置' : models?.models.find(item => item.model === name)?.visibility !== 'visible' ? ' · 未确认可见' : ''}</option>)}</select></label>
    <p className="wb-help">{capabilityText}</p>
    {referenceMode && <div className="wb-references" onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!importing) void imports(event.dataTransfer.files); }}><div className="wb-section-heading"><h3>参考图片{image ? '（可选）' : ''}</h3><span>{draft.inputAssets.length} / {count}</span></div><div className="wb-reference-grid">{draft.inputAssets.map((asset, index) => <div className="wb-reference" key={asset.assetId + '-' + index}>{asset.availability === 'available' ? <img src={asset.previewUrl} alt={`参考图 ${index + 1}：${asset.displayName}`} /> : <span>文件缺失</span>}<span className="wb-reference-number">{index + 1}</span><button className="wb-remove" type="button" aria-label={`移除参考图 ${index + 1}`} onClick={() => onChange({ inputAssets: draft.inputAssets.filter((_, position) => position !== index) })}><X size={15} /></button><p>{asset.displayName}</p>{count === 2 && <div className="wb-reference-order"><button type="button" aria-label={`参考图 ${index + 1} 前移`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button type="button" aria-label={`参考图 ${index + 1} 后移`} disabled={index === draft.inputAssets.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button></div>}</div>)}{draft.inputAssets.length < count && <button type="button" className="wb-upload" disabled={importing} onClick={() => void imports()}><ImagePlus size={24} /><span>{importing ? '正在复制素材…' : '导入参考图'}</span><small>PNG / JPEG · 可拖入</small></button>}</div><input ref={input} type="file" accept="image/png,image/jpeg" multiple={count === 2} hidden onChange={event => { if (event.target.files) void imports(event.target.files); }} /><p className="wb-help">导入即复制到本机素材目录。移除只改变草稿引用。{count === 2 && '双图是有序参考，不代表首尾帧锁定。'}</p></div>}
    {importError && <p className="wb-error" role="alert">{importError}</p>}
    <label>{image ? '画面描述' : '剧情描述'}<textarea rows={8} value={draft.prompt} onChange={event => onChange({ prompt: event.target.value })} placeholder={image ? '描述你想创作的画面、光线和氛围…' : '描述镜头、人物动作与对白…'} /></label><p className="wb-character-count">{draft.prompt.length} 字</p>
    {!image && <div className="wb-specs"><span>6 秒 · 固定</span><span>16:9</span><span>1280 × 720</span></div>}
    {Boolean(error) && <div role="alert" className="wb-error">{localErrorMessage(error)}<button type="button" onClick={onRetry}>重试保存</button><button type="button" onClick={onReload}>重新读取本机草稿（放弃未保存修改）</button></div>}
    <div className="wb-editor-footer"><p className="wb-help">{!connection?.hasCredential ? '配置连接后，再由你确认提交生成。' : '当前可编辑草稿与素材，生成提交尚未开放。'}</p><button type="button" className="wb-primary" onClick={onConfigure}><Sparkles size={17} />{!connection?.hasCredential ? '配置连接后生成' : '查看连接与能力'}</button></div>
  </section>;
}
export const VIDEO_MODES: Array<{ mode: DraftMode; title: string }> = [{ mode: 'video.text', title: '文生视频' }, { mode: 'video.single_reference', title: '单图生视频' }, { mode: 'video.dual_reference', title: '双图参考' }];
