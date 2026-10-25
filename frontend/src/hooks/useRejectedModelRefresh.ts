'use client';
import { useEffect, useRef } from 'react';
import { checkConnection } from '@/lib/connection-client';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import type { HistoryTask } from '@/lib/workbench-client';

// Existing task-history updates provide retry opportunities; no additional polling loop.
export function useRejectedModelRefresh(connection: ConnectionSummary | null, tasks: HistoryTask[] | undefined, onModels: (value: ConnectionModels) => void) {
  const completed = useRef(new Set<string>());
  const attempts = useRef(new Map<string, { pending: boolean; at: number }>());
  const currentVersion = useRef(connection?.connectionVersionId);
  currentVersion.current = connection?.connectionVersionId;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!connection) return;
    const version = connection.connectionVersionId;
    const rejected = (tasks || []).filter(task => task.taskError?.code === 'MODEL_UNAVAILABLE' && !completed.current.has(version + ':' + task.localTaskId));
    if (!rejected.length) return;
    const previous = attempts.current.get(version);
    if (previous && (previous.pending || Date.now() - previous.at < 30000)) return;
    attempts.current.set(version, { pending: true, at: Date.now() });
    void checkConnection(connection, false, 'submit').then(value => {
      if (!mounted.current || currentVersion.current !== version || value.stale || value.connectionVersionId !== version || !value.models || value.refreshError || value.connection?.validationState !== 'verified') return;
      onModels(value as ConnectionModels);
      for (const task of rejected) completed.current.add(version + ':' + task.localTaskId);
    }).catch(() => { /* Keep the event eligible for a bounded retry. */ }).finally(() => {
      attempts.current.set(version, { pending: false, at: Date.now() });
    });
  }, [connection, tasks, onModels]);
}
