'use client';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Check } from 'lucide-react';
import { saveModelSettings, sameConnectionTransport, type ConnectionModels, type ConnectionSummary } from '@/lib/connection-client';
import { videoDefaults, videoPrice, type VideoRule } from '@/lib/workbench-model-catalog';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';

export function VideoDurationControl({ connection, model, rule, models, seconds, inputRef, onChange, onModels }: {
  connection: ConnectionSummary | null; model: string; rule: VideoRule; models: ConnectionModels | null;
  seconds: unknown; inputRef: RefObject<HTMLInputElement | null>; onChange: (value: number | '') => void;
  onModels?: (value: ConnectionModels) => void;
}) {
  const id = useId(), mounted = useRef(true), busy = useRef(false);
  const [saving, setSaving] = useState(false), [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState<{ seconds: number; source: ConnectionModels | null } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useUpdateBlocker(() => busy.current);
  const scopedModels = connection && models && sameConnectionTransport(connection, models) ? models : null;
  const defaultSeconds = confirmed?.source === models ? confirmed.seconds : videoDefaults(model, rule, scopedModels).seconds;
  const validSeconds = videoPrice(rule, seconds) !== null;
  const alreadyDefault = validSeconds && Number(seconds) === defaultSeconds;
  async function save() {
    if (!connection || busy.current || alreadyDefault || !validSeconds) return;
    const selectedSeconds = Number(seconds), source = models;
    busy.current = true; setSaving(true); setNotice('');
    try {
      const value = await saveModelSettings(connection, { model, defaultSeconds: selectedSeconds });
      if (!mounted.current) return;
      if (!sameConnectionTransport(connection, value) || value.modelSettings?.[model]?.defaultSeconds !== selectedSeconds)
        throw Error('DEFAULT_SECONDS_NOT_CONFIRMED');
      setConfirmed({ seconds: selectedSeconds, source }); onModels?.(value);
      setNotice('已保存此型号的默认时长。');
    } catch { if (mounted.current) setNotice('默认时长保存失败，请重试。'); }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }
  return <div className="wb-duration-control">
    <div className="wb-duration-label"><label htmlFor={id}>视频时长（秒）</label><small>默认 {defaultSeconds} 秒</small></div>
    <div className="wb-duration-row"><input ref={inputRef} id={id} aria-label="视频时长（秒）" type="number" min={rule.minSeconds} max={rule.maxSeconds} step="1" value={String(seconds ?? '')} onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
      <button type="button" className="wb-duration-default" disabled={saving || alreadyDefault || !validSeconds || !connection} onClick={() => void save()}>{saving ? '保存中…' : alreadyDefault ? <><Check size={15} aria-hidden="true" />已设为默认</> : '设为默认'}</button>
    </div>
    {notice && <p role="status" className={notice.includes('失败') ? 'wb-error' : 'wb-help'}>{notice}</p>}
  </div>;
}
