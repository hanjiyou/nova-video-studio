'use client';

import { useEffect, useRef, useState } from 'react';
import { editorMessage, editorViewport, getEditorBridge, readEditorState, unsupportedEditorState, type EditorState } from '@/lib/openchatcut-client';

/** The original editor is hosted by a dedicated native View, never an iframe. */
export function WorkbenchEditor({ frozen = false }: { frozen?: boolean }) {
  const area = useRef<HTMLDivElement>(null);
  const retry = useRef<(() => void) | null>(null);
  const [state, setState] = useState<EditorState>({ phase: 'idle', available: false, engineCommit: '' });
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    const bridge = getEditorBridge();
    if (!bridge) { setState(unsupportedEditorState()); setBusy(false); return; }
    if (frozen) { void bridge.hideEditor().catch(() => {}); return; }
    let active = true, opening = false, eventReceived = false, resumeAfterOpening = false, activationRequested = false;
    let frame: number | null = null;
    let latest: EditorState = { phase: 'idle', available: false, engineCommit: '' };
    let lastViewport = '';
    let viewportQueue = Promise.resolve();
    const fail = (code: string) => {
      if (!active) return;
      latest = { ...latest, phase: 'failed', code };
      setState(latest); setBusy(false); schedule();
    };
    const sendViewport = () => {
      frame = null;
      if (!active || !area.current) return;
      const viewport = editorViewport(area.current.getBoundingClientRect(), window.innerWidth, window.innerHeight,
        latest.phase === 'ready' && !document.hidden);
      const key = JSON.stringify(viewport);
      if (key === lastViewport) return;
      lastViewport = key;
      viewportQueue = viewportQueue.catch(() => {}).then(async () => {
        if (!active) return;
        const result = await bridge.setEditorViewport(viewport);
        if (!result.ok && viewport.visible) fail('EDITOR_VIEWPORT_FAILED');
      }).catch(() => { if (viewport.visible) fail('EDITOR_VIEWPORT_FAILED'); });
    };
    const schedule = () => {
      if (active && frame === null) frame = window.requestAnimationFrame(sendViewport);
    };
    const accept = (value: unknown, autoStart = true) => {
      if (!active) return;
      const next = readEditorState(value);
      if (!next) { fail('EDITOR_STATE_INVALID'); return; }
      latest = next; setState(next); setBusy(next.phase === 'starting'); schedule();
      if (autoStart && next.available && !document.hidden && (next.phase === 'idle' || next.phase === 'stopped' || (next.phase === 'ready' && !activationRequested))) void start();
    };
    const rejectResult = (result: { code?: string; state?: EditorState }, fallback: string) => {
      const provided = readEditorState(result.state);
      if (provided) accept(readEditorState({ ...provided, code: result.code ?? provided.code }) ?? provided, false);
      else fail(readEditorState({ ...latest, code: result.code })?.code ?? fallback);
    };
    const start = async () => {
      if (!active || opening) return;
      opening = true; activationRequested = true; setBusy(true);
      accept({ ...latest, phase: 'starting', code: undefined });
      try {
        const result = await bridge.openEditor();
        if (active) { if (result.ok) accept(result.state, false); else rejectResult(result, 'EDITOR_START_FAILED'); }
      } catch { fail('EDITOR_START_FAILED'); }
      finally {
        opening = false; if (active) setBusy(false);
        if (active && resumeAfterOpening && !document.hidden) { resumeAfterOpening = false; void start(); }
      }
    };
    retry.current = () => { void start(); };
    let off: (() => void) | undefined;
    try { off = bridge.onEditorState(value => { eventReceived = true; accept(value); }); }
    catch { fail('EDITOR_STATE_FAILED'); }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (area.current) observer?.observe(area.current);
    const onVisibility = () => {
      if (document.hidden) void bridge.hideEditor().catch(() => {});
      else if (opening) resumeAfterOpening = true;
      else void start();
      lastViewport = ''; schedule();
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', onVisibility);
    void bridge.getEditorState().then(result => {
      if (!active || eventReceived) return;
      if (!result.ok) { rejectResult(result, 'EDITOR_STATE_FAILED'); return; }
      accept(result.state);
    }).catch(() => { if (!eventReceived) fail('EDITOR_STATE_FAILED'); });
    schedule();
    return () => {
      active = false; retry.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect(); off?.();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', onVisibility);
      void bridge.hideEditor().catch(() => {});
    };
  }, [frozen]);

  const unsupported = state.code === 'EDITOR_UNSUPPORTED';
  return <section ref={area} className="wb-editor-workspace" aria-label="OpenChatCut 原版剪辑工作区" data-phase={state.phase}>
    {state.phase !== 'ready' && <div className="wb-editor-status" role={state.phase === 'failed' ? 'alert' : 'status'} aria-live="polite">
      <h2>{state.phase === 'unavailable' ? '视频剪辑尚未就绪' : '视频剪辑'}</h2>
      <p>{editorMessage(state)}</p>
      {!unsupported && !frozen && <button type="button" className="wb-primary" disabled={busy || state.phase === 'starting'} onClick={() => retry.current?.()}>
        {busy || state.phase === 'starting' ? '正在打开…' : '重新打开剪辑'}
      </button>}
    </div>}
  </section>;
}
