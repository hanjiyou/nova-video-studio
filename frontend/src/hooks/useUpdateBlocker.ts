'use client';
import { useEffect, useRef } from 'react';
import { notifyUpdateReadiness, registerUpdateBlocker } from '@/lib/update-readiness';
export function useUpdateBlocker(check: () => boolean) {
  const current = useRef(check); current.current = check;
  useEffect(() => registerUpdateBlocker(() => current.current()), []);
  useEffect(() => { notifyUpdateReadiness(); });
}
