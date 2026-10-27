"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_GROUP_ID, getWorkbenchGroups, localErrorMessage, type GroupRecovery, type WorkbenchGroup } from '@/lib/workbench-client';
export const DEFAULT_GROUP: WorkbenchGroup = { groupId: DEFAULT_GROUP_ID, name: '未分组', isDefault: true, createdAt: '', outputLocation: '' };
export function useWorkbenchGroups(revision = 0) {
  const [groups, setGroups] = useState<WorkbenchGroup[]>([DEFAULT_GROUP]), [error, setError] = useState(''), [recovery,setRecovery] = useState<GroupRecovery[]>([]), [loaded,setLoaded] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    try { const result = await getWorkbenchGroups(); if (!Array.isArray(result.items)) throw Error('LOCAL_SERVICE_FAILED'); if (ticket === sequence.current) { setLoaded(true);setGroups(result.items); setRecovery(result.recovery || []); setError(''); } }
    catch (error) { if (ticket === sequence.current) setError(localErrorMessage(error)); }
  }, []);
  useEffect(() => { void refresh(); return () => { sequence.current++; }; }, [refresh, revision]);
  return { groups, error, refresh, recovery, loaded };
}
