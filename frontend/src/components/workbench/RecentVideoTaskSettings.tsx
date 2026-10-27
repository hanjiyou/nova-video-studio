'use client';
import { useEffect, useRef, useState } from 'react';
import { localErrorMessage } from '@/lib/workbench-client';
import { isUpdateFrozen } from '@/lib/update-readiness';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';

export function RecentVideoTaskSettings({ value, onSave, onReload }: { value: number; onSave: (limit: number) => Promise<void>; onReload: () => Promise<number> }) {
  const [input, setInput] = useState(String(value)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setInput(String(value)); }, [value]);
  const valid = /^\d+$/.test(input) && Number.isInteger(Number(input)) && Number(input) >= 1 && Number(input) <= 100;
  const dirty = input !== String(value);
  useUpdateBlocker(() => pending.current || dirty);

  async function run(reload = false) {
    if (isUpdateFrozen() || pending.current || (!reload && (!valid || conflict))) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const next = reload ? await onReload() : Number(input);
      if (!reload) await onSave(next);
      if (mounted.current) { setInput(String(next)); setConflict(false); setNotice(reload ? '已重新读取显示设置。' : '显示设置已保存。视频工作台立即使用此数量。'); }
    } catch (error) {
      if (mounted.current) {
        const changed = error instanceof Error && error.message === 'SETTING_REVISION_CONFLICT';
        setConflict(changed);
        setError(changed ? '显示设置已在其他操作中更新。输入已保留，请重新读取后再修改保存。' : error instanceof Error && error.message === 'INVALID_SETTING_VALUE' ? '显示设置未确认保存，请重新读取后再试。' : localErrorMessage(error));
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  return <section className="wb-panel wb-form" aria-label="工作台显示"><h2>工作台显示</h2>
    <label className="wb-recent-video-limit">最近视频任务数量<input type="number" min="1" max="100" step="1" inputMode="numeric" value={input} disabled={busy} onChange={event => { setInput(event.target.value); setNotice(''); }} /></label>
    <p className="wb-help">默认 6 条，可设为 1–100 的整数。保存后立即生效并在重启后保留；图片仍显示最近 6 条，全部记录可在作品库查看。</p>
    {!valid && <p className="wb-warning">请填写 1–100 的整数，不能为空。</p>}{error && <p role="alert" className="wb-error">{error}</p>}{notice && <p role="status" className="wb-notice">{notice}</p>}
    <div className="wb-actions"><button type="button" disabled={busy || !valid || conflict} onClick={() => void run()}>{busy ? '正在读取或保存…' : '保存显示设置'}</button><button type="button" disabled={busy} onClick={() => void run(true)}>重新读取显示设置</button></div>
  </section>;
}
