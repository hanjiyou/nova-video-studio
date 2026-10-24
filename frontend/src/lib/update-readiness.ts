// Local readiness supplements the main-process activity barrier; it never authorizes installation.
const blockers = new Set<() => boolean>();
const listeners = new Set<() => void>();
let frozen = false;
export const isUpdateFrozen = () => frozen;
export const setUpdateFrozen = (value: boolean) => { frozen = value; };
export function notifyUpdateReadiness() { for (const listener of listeners) listener(); }
export function subscribeUpdateReadiness(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function registerUpdateBlocker(check: () => boolean) { blockers.add(check); notifyUpdateReadiness(); return () => { blockers.delete(check); notifyUpdateReadiness(); }; }
export function hasUpdateBlockers() { for (const check of blockers) { try { if (check()) return true; } catch { return true; } } return false; }
