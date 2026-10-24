'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppUpdateState } from '@/lib/app-update';
import { hasUpdateBlockers, setUpdateFrozen } from '@/lib/update-readiness';
export function useAppUpdate(flush: () => Promise<void>, ready: boolean) {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [frozen, setFrozen] = useState(false);
  const current = useRef({ flush, ready }); current.current = { flush, ready };
  const freeze = useCallback((value: boolean) => { setUpdateFrozen(value); setFrozen(value); }, []);
  const accept = useCallback((value: AppUpdateState) => {
    setState(value);
    freeze(['preparing', 'installing', 'closed-error'].includes(value.phase));
  }, [freeze]);
  useEffect(() => {
    const api = window.novaDesktop;
    if (!api?.getUpdateState || !api?.onUpdateState || !api?.onUpdateFlush) return;
    let active = true, eventReceived = false;
    const offState = api.onUpdateState(value => { eventReceived = true; if (active) accept(value); });
    const offFlush = api.onUpdateFlush(request => {
      // Freeze synchronously before awaiting: a queued click cannot create a new local intent.
      freeze(true);
      void (async () => {
        let ok = false;
        try {
          if (!current.current.ready || hasUpdateBlockers()) throw Error('UPDATE_BUSY');
          await current.current.flush();
          if (hasUpdateBlockers()) throw Error('UPDATE_BUSY');
          ok = true;
        } catch { /* Main process exposes a fixed save-failure message. */ }
        if (active) await api.acknowledgeUpdateFlush({ id: request.id, ok }).catch(() => {});
      })();
    });
    void api.getUpdateState().then(value => { if (active && !eventReceived) accept(value); }).catch(() => {});
    return () => { active = false; offState(); offFlush(); setUpdateFrozen(false); };
  }, [freeze, accept]);
  const install = useCallback(async () => {
    if (!current.current.ready || hasUpdateBlockers()) return;
    freeze(true);
    const api = window.novaDesktop;
    const result = await api?.installUpdate().catch(() => undefined);
    if (!result?.ok) {
      const latest = result?.state || await api?.getUpdateState().catch(() => undefined);
      if (latest) accept(latest);
      else if (result?.code === 'IPC_FORBIDDEN' || result?.code === 'INVALID_ARGUMENT') freeze(false);
      // An unknown transport outcome may have closed the backend: wait for authoritative state.
    }
  }, [freeze, accept]);
  return { state, frozen, install };
}
