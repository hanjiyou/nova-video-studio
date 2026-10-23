'use client';
import dynamic from 'next/dynamic';
import { useSyncExternalStore } from 'react';
// Keep the old Web product out of the desktop dependency/mount tree.
const DesktopWorkbench = dynamic(() => import('@/components/workbench/WorkbenchShell').then(module => module.WorkbenchShell));
const LegacyWorkspace = dynamic(() => import('./LegacyWorkspaceShell').then(module => module.LegacyWorkspaceShell));
export function WorkspaceShell() {
  const desktop = useSyncExternalStore(() => () => {}, () => Boolean(window.novaDesktop), () => null);
  if (desktop === null) return null;
  return desktop ? <DesktopWorkbench /> : <LegacyWorkspace />;
}
