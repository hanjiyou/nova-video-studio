import { acceptTask } from './workbench-task-state';
import { generateUUID } from './uuid';
import type { GroupRecovery, HistoryTask, WorkbenchGroup } from './workbench-client';
export class GroupActionError extends Error { constructor(public code: string, public statusCode: number) { super(code); } }
async function request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/nova/storage/' + route, { cache: 'no-store', method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new GroupActionError(result.code || 'GROUP_OPERATION_FAILED', response.status); return result as T;
}
const moveListeners = new Set<(before:HistoryTask,after:HistoryTask)=>void>();
export const watchCompletedGroupMoves = (listener:(before:HistoryTask,after:HistoryTask)=>void) => {moveListeners.add(listener);return()=>{moveListeners.delete(listener);};};
const operations = new Map<string, { signature: string; requestId: string; promise?: Promise<unknown> }>(), listeners = new Set<() => void>();
const publish = () => listeners.forEach(listener => listener());
export const watchGroupOperations = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const groupOperationPending = (key: string) => Boolean(operations.get(key)?.promise);
export const unconfirmedGroupInput = (key: string): unknown => { const operation = operations.get(key); return operation ? JSON.parse(operation.signature) : undefined; };
export const groupReceiptUnknown = (error: unknown) => !(error instanceof GroupActionError) || error.statusCode >= 500;
async function tracked<T>(key: string, signature: unknown, run: (requestId: string) => Promise<T>): Promise<T> {
  const encoded = JSON.stringify(signature); let operation = operations.get(key);
  if (operation && operation.signature !== encoded) throw new GroupActionError('GROUP_REQUEST_UNCONFIRMED', 409);
  if (operation?.promise) return operation.promise as Promise<T>;
  if (!operation) { operation = { signature: encoded, requestId: generateUUID() }; operations.set(key, operation); }
  const current = operation;
  const promise = Promise.resolve().then(() => run(current.requestId)).then(value => { operations.delete(key); return value; }, error => { if (!groupReceiptUnknown(error)) operations.delete(key); throw error; }).finally(() => { current.promise = undefined; publish(); });
  current.promise = promise; publish(); return promise;
}
export function reconcileGroupMove(task: HistoryTask) {
  const key = 'task:' + task.localTaskId, previous = operations.get(key);
  if (previous && !previous.promise) { const input = JSON.parse(previous.signature); if (task.groupId === input.groupId && task.groupRevision !== input.expectedRevision) operations.delete(key); }
}
export async function moveTaskGroup(task: HistoryTask, groupId: string) {
  reconcileGroupMove(task);
  const result = await tracked<{task: HistoryTask; movedFiles: number; unchanged?: boolean}>('task:' + task.localTaskId, { groupId, expectedRevision: task.groupRevision }, requestId => request('tasks/' + encodeURIComponent(task.localTaskId) + '/group', 'POST', { groupId, requestId, ...(task.groupRevision === undefined ? {} : { expectedRevision: task.groupRevision }) }));
  const after=acceptTask(result.task);moveListeners.forEach(listener=>listener(task,after));return { ...result, task: after };
}
export const renameWorkbenchGroup = (groupId: string, name: string) => tracked<{group: WorkbenchGroup}>('rename:' + groupId, {name}, requestId => request('groups/' + encodeURIComponent(groupId) + '/rename', 'POST', { name, requestId }));
export const archiveWorkbenchGroup = (groupId: string, archived: boolean) => request<{group: WorkbenchGroup}>('groups/' + encodeURIComponent(groupId) + '/archive', 'POST', { archived });
export const deleteWorkbenchGroup = (groupId: string) => request<{groupId: string; deleted: boolean}>('groups/' + encodeURIComponent(groupId), 'DELETE');
export interface HistoryOrganizationPreview { items: Array<{taskId: string; groupId: string; files: Array<{assetId: string; source: string; target: string}>; conflicts: Array<{code: string; message: string}>}>; total: number }
export interface HistoryOrganizationResult { items: Array<{taskId: string; ok: boolean; code?: string; message?: string; movedFiles?: number}>; succeeded: number; failed: number }
export const previewHistoryOrganization = (groupId?: string) => request<HistoryOrganizationPreview>('groups/history-preview' + (groupId ? '?groupId=' + encodeURIComponent(groupId) : ''));
export const organizeHistoryFiles = (taskIds: string[]) => tracked<HistoryOrganizationResult>('history', taskIds, requestId => request('groups/organize-history', 'POST', { taskIds, requestId }));
export const resetGroupOperationsForTests = () => operations.clear();

export const recoverGroupOperations = () => request<{unresolved:GroupRecovery[]}>('groups/recover','POST',{});
