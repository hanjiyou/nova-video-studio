'use client';

import { useSyncExternalStore } from 'react';

const webFeatures = Object.freeze({ agent: true, browserAutomation: true, serviceWorker: true });
const subscribe = () => () => {};
const snapshot = () => window.novaDesktop?.features ?? webFeatures;
const serverSnapshot = () => null;

/** Preload flags are immutable. Wait for hydration before mounting privileged workspaces. */
export function useDesktopFeatures() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
