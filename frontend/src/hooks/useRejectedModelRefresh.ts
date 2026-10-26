'use client';
import { useEffect, useRef } from 'react';
import { checkConnection, sameConnectionTransport } from '@/lib/connection-client';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import type { HistoryTask } from '@/lib/workbench-client';

// Existing task-history updates provide retry opportunities; no additional polling loop.
export function useRejectedModelRefresh(connection: ConnectionSummary | null, tasks: HistoryTask[] | undefined, onModels: (value: ConnectionModels) => void) {
  const completed = useRef(new Set<string>());
  const attempts = useRef(new Map<string, { pending: boolean; at: number }>());
  const identity = connection ? JSON.stringify([connection.connectionVersionId, connection.route, connection.routeRevision]) : null;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!connection) return;
    const scope = identity!;
    const rejected = (tasks || []).filter(task => task.taskError?.code === 'MODEL_UNAVAILABLE' && (!task.connectionVersionId || task.connectionVersionId === connection.connectionVersionId) && (task.transportRoute ? task.transportRoute.route === connection.route && task.transportRoute.revision === connection.routeRevision : connection.routeRevision == null) && !completed.current.has(scope + ':' + task.localTaskId));
    if (!rejected.length) return;
    const previous = attempts.current.get(scope);
    if (previous && (previous.pending || Date.now() - previous.at < 30000)) return;
    attempts.current.set(scope, { pending: true, at: Date.now() });
    void checkConnection(connection, false, 'submit').then(value => {
      if (!mounted.current || currentIdentity.current !== scope || value.stale || !sameConnectionTransport(connection, value as ConnectionModels) || !value.models || value.refreshError || value.connection?.validationState !== 'verified') return;
      onModels(value as ConnectionModels);
      for (const task of rejected) completed.current.add(scope + ':' + task.localTaskId);
    }).catch(() => { /* Keep the event eligible for a bounded retry. */ }).finally(() => {
      attempts.current.set(scope, { pending: false, at: Date.now() });
    });
  }, [connection, identity, tasks, onModels]);
}
