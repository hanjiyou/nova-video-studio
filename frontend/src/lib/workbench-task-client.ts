export interface AssetSummary {
  assetId: string; kind: 'image' | 'video' | 'audio'; displayName: string; mimeType: string; byteLength: number; sha256: string;
  width?: number | null; height?: number | null; durationSeconds?: number | null;
  availability: 'available' | 'missing' | 'corrupt'; validationState: string; previewUrl: string;
}
/** Local completion is distinct from remote completion and download progress. */
export type WorkbenchTaskState = 'local_queued' | 'submitting' | 'submission_unknown' | 'remote_queued' | 'generating' | 'polling_paused' | 'remote_completed' | 'downloading' | 'download_failed' | 'completed' | 'failed' | 'local_cancelled' | 'remote_cancelled' | 'timed_out';
export type TaskExecutionPhase = 'reference_upload' | 'submitting' | 'receiving' | 'parsing' | 'remote_waiting' | 'downloading' | 'validating' | 'saving';
export interface DownloadAttemptDto {
  id: string; active: boolean; startedAt: string; deadlineAt: string; timeoutSeconds: number;
  outcome: 'completed' | 'failed' | 'timed_out' | 'cancelled' | null; finishedAt: string | null;
}
export interface TaskErrorDto {
  code: string;
  phase: 'validation' | 'credential' | 'submit' | 'poll' | 'download' | 'storage' | 'media' | TaskExecutionPhase;
  message: string;
  httpStatus?: number;
  retryAction: 'none' | 'edit_input' | 'reauthenticate' | 'reconcile_submission' | 'retry_poll' | 'retry_download';
  transmission: 'not_dispatched' | 'may_have_reached_upstream' | 'response_received' | 'not_applicable';
  localTaskId: string;
  upstreamTaskId?: string;
}
/** Additive execution contract; generation and explicit download-attempt outcomes remain separate. */
export interface TaskExecutionSettings {
  imageConcurrency: number; videoConcurrency: number;
  imageTimeoutSeconds: number; videoTimeoutSeconds: number;
}
export interface DurableTaskFields {
  removedFromWorkbench?: boolean;
  mediaKind?: 'image' | 'video' | null;
  localOutcome?: 'completed' | 'failed' | 'timed_out' | 'cancelled' | null;
  remoteOutcome?: 'not_dispatched' | 'unknown' | 'confirmed_result' | 'confirmed_rejected' | 'confirmed_failed' | 'confirmed_cancelled';
  executionAttemptId?: string | null;
  timeoutSeconds?: number | null;
  dispatchStartedAt?: string | null;
  deadlineAt?: string | null;
  localFinishedAt?: string | null;
  phase?: TaskExecutionPhase | null;
  phaseStartedAt?: string | null;
  localTaskId?: string;
  localRequestId?: string;
  connectionVersionId?: string;
  upstreamTaskId?: string | null;
  remoteState?: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'unknown' | null;
  rawStatus?: string | null;
  pauseReason?: string | null;
  notBeforeAt?: string | null;
  nextPollAt?: string | null;
  requiresContinue?: boolean;
  generationReserved?: boolean;
  localExecutionActive?: boolean;
  downloadAttempt?: DownloadAttemptDto | null;
  remoteMayContinue?: boolean;
  schedulingNotice?: string | null;
  taskError?: TaskErrorDto | null;
  inputAssets?: AssetSummary[];
  outputAssets?: AssetSummary[];
}
export interface WorkbenchTaskResponse extends DurableTaskFields {
  id: string;
  localTaskId: string;
  status: WorkbenchTaskState;
  mode: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: null;
  error?: string | null;
}
export type WorkbenchTaskAction = 'cancel' | 'cancel-queued' | 'continue-queued' | 'stop-polling' | 'resume-polling' | 'attach-upstream-id' | 'retry-download';
export class WorkbenchTaskActionError extends Error {
  constructor(public code: string, message: string, public statusCode: number, public notBeforeAt?: string) { super(message); this.name = 'WorkbenchTaskActionError'; }
}
export async function getWorkbenchTask(taskId: string): Promise<WorkbenchTaskResponse> {
  const response = await fetch('/api/nova/tasks/' + encodeURIComponent(taskId), { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new WorkbenchTaskActionError(result.code || 'TASK_READ_FAILED', result.error || '读取任务失败。', response.status);
  return result as WorkbenchTaskResponse;
}
export async function actOnWorkbenchTask(taskId: string, action: WorkbenchTaskAction, input: { upstreamTaskId: string } | Record<string, never> = {}): Promise<WorkbenchTaskResponse> {
  const response = await fetch('/api/nova/tasks/' + encodeURIComponent(taskId) + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new WorkbenchTaskActionError(result.code || 'TASK_ACTION_FAILED', result.error || '任务操作失败。', response.status, result.notBeforeAt);
  return result.task as WorkbenchTaskResponse;
}

/** Canonical B1 input. The caller persists this intent before sending; failed POSTs are never retried here. */
export interface WorkbenchTaskInput {
  localRequestId: string;
  connectionVersionId: string;
  capabilityVersionId: string;
  mode: 'image.text' | 'image.reference' | 'video.text' | 'video.single_reference' | 'video.dual_reference' | 'video.multi_reference';
  model: string;
  prompt: string;
  parameters: Record<string, string | number | boolean>;
  inputAssets: Array<{ assetId: string; role: 'reference'; position: number }>;
  outputDirectoryVersionId?: string;
  outputRootRef?: string;
}
export async function createWorkbenchTask(input: WorkbenchTaskInput): Promise<string> {
  const response = await fetch('/api/nova/workbench/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new WorkbenchTaskActionError(result.code || 'TASK_CREATE_FAILED', result.error || '创建任务失败。', response.status);
  return result.taskId as string;
}
