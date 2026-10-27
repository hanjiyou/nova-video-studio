'use client';
import { useCallback, useRef, useState } from 'react';
import { DEFAULT_GROUP_ID, DRAFT_MODES, Draft, DraftMode, getDraft, putDraft } from '@/lib/workbench-client';
import { isUpdateFrozen } from '@/lib/update-readiness';
export function useWorkbenchDrafts() {
  const [groupId, setGroupId] = useState(DEFAULT_GROUP_ID), [switching, setSwitching] = useState(false);
  const activeGroup = useRef(DEFAULT_GROUP_ID), switchLock = useRef(false), generation = useRef(0);
  const values = useRef<Partial<Record<DraftMode, Draft>>>({});
  const dirty = useRef(new Set<DraftMode>());
  const running = useRef(new Map<DraftMode, Promise<boolean>>());
  const [drafts, setDrafts] = useState<Partial<Record<DraftMode, Draft>>>({});
  const [saving, setSaving] = useState<Partial<Record<DraftMode, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<DraftMode, unknown>>>({});
  const publish = useCallback(() => setDrafts({ ...values.current }), []);
  const load = useCallback(async () => {
    const ticket = ++generation.current, group = activeGroup.current, previous = values.current;
    const loaded = await Promise.all(DRAFT_MODES.map(mode => getDraft(mode, group)));
    if (ticket !== generation.current || group !== activeGroup.current || switchLock.current || Object.keys(previous).some(mode => previous[mode as DraftMode] !== values.current[mode as DraftMode])) return;
    values.current = Object.fromEntries(loaded.map(draft => [draft.mode, draft]));
    publish();
  }, [publish]);
  const persist = useCallback((mode: DraftMode): Promise<boolean> => {
    const existing = running.current.get(mode); if (existing) return existing;
    setSaving(old => ({ ...old, [mode]: true }));
    setErrors(old => ({ ...old, [mode]: undefined }));
    const operation = Promise.resolve().then(async () => {
    try {
      while (dirty.current.has(mode)) {
        dirty.current.delete(mode);
        const sent = values.current[mode]!;
        const saved = await putDraft(sent);
        // A newer edit retains its content; only the acknowledged revision advances.
        values.current[mode] = values.current[mode] === sent ? saved : { ...values.current[mode]!, revision: saved.revision, updatedAt: saved.updatedAt };
        publish();
      }
      return true;
    } catch (error) { dirty.current.add(mode); setErrors(old => ({ ...old, [mode]: error })); return false; }
    finally { running.current.delete(mode); setSaving(old => ({ ...old, [mode]: false })); }
    });
    running.current.set(mode, operation); return operation;
  }, [publish]);
  const update = useCallback((mode: DraftMode, patch: Partial<Pick<Draft, 'prompt' | 'model' | 'parameters' | 'inputAssets'>>, defaultModel?: string, expectedGroup?: string) => {
    if (isUpdateFrozen() || switchLock.current || (expectedGroup && expectedGroup !== activeGroup.current) || !values.current[mode]) return;
    values.current[mode] = { ...values.current[mode]!, model: values.current[mode]!.model || defaultModel || '', ...patch };
    dirty.current.add(mode); publish(); void persist(mode);
  }, [persist, publish]);
  const reload = useCallback(async (mode: DraftMode) => {
    if (running.current.has(mode) || switchLock.current) return;
    const group = activeGroup.current, ticket = generation.current, previous = values.current[mode];
    const loaded = await getDraft(mode, group);
    if (switchLock.current || ticket !== generation.current || group !== activeGroup.current || previous !== values.current[mode]) return;
    values.current[mode] = loaded; dirty.current.delete(mode);
    setErrors(old => ({ ...old, [mode]: undefined })); publish();
  }, [publish]);
  const flush = useCallback(async () => {
    if (DRAFT_MODES.some(mode => !values.current[mode])) throw Error('UPDATE_SAVE_FAILED');
    const saved = await Promise.all(DRAFT_MODES.map(persist));
    if (saved.some(ok => !ok) || dirty.current.size || running.current.size) throw Error('UPDATE_SAVE_FAILED');
  }, [persist]);
  const switchGroup = useCallback(async (next: string) => {
    if (switchLock.current || isUpdateFrozen()) return false;
    if (next === activeGroup.current) return true;
    switchLock.current = true; generation.current++; setSwitching(true);
    try {
      await flush();
      const loaded = await Promise.all(DRAFT_MODES.map(mode => getDraft(mode, next)));
      values.current = Object.fromEntries(loaded.map(draft => [draft.mode, draft]));
      activeGroup.current = next; setGroupId(next); setErrors({}); publish();
      return true;
    } finally { switchLock.current = false; setSwitching(false); }
  }, [flush, publish]);
  return { drafts, saving, errors, load, update, retry: persist, reload, flush, groupId, switching, switchGroup };
}
