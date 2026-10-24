'use client';
import { useEffect, useState } from 'react';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import { localErrorMessage, PRESET_MODELS } from '@/lib/workbench-client';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';
export interface OutputDirectory { ok: boolean; displayName?: string; outputDirectoryVersionId?: string; outputRootRef?: string; code?: string; cancelled?: boolean }
export function DefaultSettings({ connection, models, onboarding, onComplete, onBack }: { connection: ConnectionSummary; models: ConnectionModels | null; onboarding?: boolean; onComplete: (image: string, video: string) => Promise<void>; onBack?: () => void }) {
  const [image, setImage] = useState(connection.defaultImageModel);
  const [video, setVideo] = useState(connection.defaultVideoModel);
  const [directory, setDirectory] = useState<OutputDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [observedAt] = useState(() => Date.now());
  useUpdateBlocker(() => busy || image !== connection.defaultImageModel || video !== connection.defaultVideoModel);
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
      setDirectory(result); await onComplete(image, video);
    } catch (e) { setError(localErrorMessage(e)); }
    finally { setBusy(false); }
  }
  const visibleModels = models?.models.filter(item => item.visibility === 'visible').map(item => item.model) || [];
  function modelField(label: string, value: string, set: (value: string) => void, fallback: string) {
    const item = models?.models.find(item => item.model === value);
    const absent = Boolean(models?.modelsFetchedAt && !visibleModels.includes(value));
    return <div><label>{label}<input value={value} onChange={event => set(event.target.value)} list={label === '图片默认模型' ? 'wb-image-models' : 'wb-video-models'} maxLength={200} autoComplete="off" /></label><datalist id={label === '图片默认模型' ? 'wb-image-models' : 'wb-video-models'}>{[...new Set([fallback, ...visibleModels])].map(name => <option key={name} value={name} />)}</datalist><p className={absent ? 'wb-warning' : 'wb-help'}>{absent ? `当前模型列表缺少 ${value}；保留该完整型号，相关生成暂不可用。请明确选择替代型号，应用不会自动替换。` : item?.visibility === 'visible' ? '列表中可见；具体模式和规格仍需独立能力证据。' : '型号可保存为待验证；没有模型列表或能力证据时不会启用生成。'}</p></div>;
  }
  const validModel = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
  return <section className="wb-form" aria-label="默认模型与保存位置"><h2>{onboarding ? '选择默认项，开始创作' : '默认模型与保存位置'}</h2><p className="wb-help">默认项仅用于新草稿与新任务；已有草稿、任务快照和结果目录保持原记录。</p>
    <details className="wb-model-cache"><summary>模型列表与能力说明</summary><p className="wb-help">模型缓存时间：{models?.modelsFetchedAt ? new Date(models.modelsFetchedAt).toLocaleString('zh-CN') : '尚未获取'}。{connection.validationState !== 'verified' || !models?.modelsFetchedAt || observedAt - Date.parse(models.modelsFetchedAt) > 300000 ? '当前列表可能过期，仅供参考，请重新检查连接。' : '仅表示最近只读检查时的可见性。'}</p><ul>{models?.models.map(item => <li key={item.model}>{item.model}<span>{item.visibility === 'visible' ? '缓存中可见' : item.visibility === 'absent' ? '列表未找到' : '尚未核对'}</span></li>)}</ul><p className="wb-help">生成能力按服务、完整型号、模式、协议与规格分别验证。历史双图参考证据不代表本应用已完成真实生成验收；其他未验证组合不会因列表可见而启用。</p></details>
    {modelField('图片默认模型', image, setImage, PRESET_MODELS[0])}{modelField('视频默认模型', video, setVideo, PRESET_MODELS[2])}
    <div className="wb-directory"><div><span className="wb-label">作品保存位置</span><p>{directory?.displayName || '正在读取本机目录…'}</p><p className="wb-help">本机受管目录 · 选择后验证可写并立即应用于新任务。已有文件不自动搬迁。</p></div><button type="button" disabled={busy} onClick={() => void choose()}>选择文件夹</button></div>
    {directoryError && <p role="alert" className="wb-error">{directoryError}</p>}{error && <p role="alert" className="wb-error">{error}</p>}
    <p className="wb-help">视频预设为 6 秒、16:9、1280×720；双图是有序参考，不承诺首尾帧锁定。</p>
    <div className="wb-actions">{onBack && <button type="button" disabled={busy} onClick={onBack}>上一步</button>}<button type="button" className="wb-primary" disabled={busy || !directory || !validModel(image) || !validModel(video)} onClick={() => void complete()}>{busy ? '检查目录并保存…' : onboarding ? '进入工作台' : '保存默认项'}</button></div>
  </section>;
}
