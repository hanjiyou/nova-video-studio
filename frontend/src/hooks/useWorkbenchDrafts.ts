'use client';
import { useCallback, useRef, useState } from 'react';
import { DRAFT_MODES, Draft, DraftMode, getDraft, putDraft } from '@/lib/workbench-client';
export function useWorkbenchDrafts() {
  const values = useRef<Partial<Record<DraftMode, Draft>>>({});
  const dirty = useRef(new Set<DraftMode>());
  const running = useRef(new Set<DraftMode>());
  const [drafts, setDrafts] = useState<Partial<Record<DraftMode, Draft>>>({});
  const [saving, setSaving] = useState<Partial<Record<DraftMode, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<DraftMode, unknown>>>({});
  const publish = useCallback(() => setDrafts({ ...values.current }), []);
  const load = useCallback(async () => {
    const loaded = await Promise.all(DRAFT_MODES.map(getDraft));
    values.current = Object.fromEntries(loaded.map(draft => [draft.mode, draft]));
    publish();
  }, [publish]);
  const persist = useCallback(async (mode: DraftMode) => {
    if (running.current.has(mode)) return;
    running.current.add(mode);
    setSaving(old => ({ ...old, [mode]: true }));
    setErrors(old => ({ ...old, [mode]: undefined }));
    try {
      while (dirty.current.has(mode)) {
        dirty.current.delete(mode);
        const sent = values.current[mode]!;
        const saved = await putDraft(sent);
        // A newer edit retains its content; only the acknowledged revision advances.
        values.current[mode] = values.current[mode] === sent ? saved : { ...values.current[mode]!, revision: saved.revision, updatedAt: saved.updatedAt };
        publish();
      }
    } catch (error) { dirty.current.add(mode); setErrors(old => ({ ...old, [mode]: error })); }
    finally { running.current.delete(mode); setSaving(old => ({ ...old, [mode]: false })); }
  }, [publish]);
  const update = useCallback((mode: DraftMode, patch: Partial<Pick<Draft, 'prompt' | 'model' | 'parameters' | 'inputAssets'>>, defaultModel?: string) => {
    if (!values.current[mode]) return;
    values.current[mode] = { ...values.current[mode]!, model: values.current[mode]!.model || defaultModel || '', ...patch };
    dirty.current.add(mode); publish(); void persist(mode);
  }, [persist, publish]);
  const reload = useCallback(async (mode: DraftMode) => {
    if (running.current.has(mode)) return;
    values.current[mode] = await getDraft(mode); dirty.current.delete(mode);
    setErrors(old => ({ ...old, [mode]: undefined })); publish();
  }, [publish]);
  return { drafts, saving, errors, load, update, retry: persist, reload };
}
