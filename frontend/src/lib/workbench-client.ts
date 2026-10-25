import { MAX_REFERENCE_ASSETS } from './reference-policy';
import type { AssetSummary, WorkbenchTaskResponse, WorkbenchTaskInput } from './workbench-task-client';
export const DRAFT_MODES = ['image.text', 'video.text', 'video.single_reference', 'video.dual_reference'] as const;
export type DraftMode = typeof DRAFT_MODES[number];
export type WorkbenchPage = 'image' | 'video' | 'library' | 'settings';
export const WORKBENCH_PAGES: WorkbenchPage[] = ['image', 'video', 'library', 'settings'];
export const PRODUCT_FEATURES = Object.freeze({ image: true, video: true, library: true, settings: true, agent: false, canvas: false, gif: false, promptGallery: false, browserAutomation: false, pluginManagement: false });
export interface Draft {
  mode: DraftMode; prompt: string; model: string; parameters: Record<string, string | number | boolean>;
  inputAssets: AssetSummary[]; revision: number; updatedAt: string | null;
}
export interface WorkspacePreferences { activeMode?: DraftMode; activePage?: WorkbenchPage; returnPage?: 'image' | 'video' | 'library'; wideMode?: boolean }
export interface OnboardingPreferences { dismissed?: boolean; step?: 'connection' | 'defaults' | 'completed' }
export interface Setting<T> { key: string; value: T | null; revision: number; updatedAt: string | null }
export class LocalServiceError extends Error { constructor(public code: string) { super(code); } }
export async function localRead<T>(route: string, options?: RequestInit): Promise<T> {
  const response = await fetch(route, { cache: 'no-store', ...options });
  const result = await response.json();
  if (!response.ok) throw new LocalServiceError(result.code || 'LOCAL_SERVICE_FAILED');
  return result as T;
}
export const getDraft = async (mode: DraftMode) => (await localRead<{ draft: Draft }>('/api/nova/storage/drafts/' + mode)).draft;
export const putDraft = async (draft: Draft) => (await localRead<{ draft: Draft }>('/api/nova/storage/drafts/' + draft.mode, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: draft.prompt, model: draft.model, parameters: draft.parameters, inputAssets: draft.inputAssets.map((asset, position) => ({ assetId: asset.assetId, role: 'reference', position })), expectedRevision: draft.revision }) })).draft;
export const getSetting = async <T>(key: string) => (await localRead<{ setting: Setting<T> }>('/api/nova/storage/settings/' + key)).setting;
export const putSetting = async <T>(key: string, value: T, expectedRevision: number) => (await localRead<{ setting: Setting<T> }>('/api/nova/storage/settings/' + key, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, expectedRevision }) })).setting;
export interface HistoryTask extends WorkbenchTaskResponse { prompt: string; model: string; parameters: Record<string, string | number | boolean>; capabilityVersionId?: string; outputDirectoryVersionId?: string; outputRootRef?: string; outputLocation?: string }
export interface HistoryQuery { limit?: number; offset?: number; kind?: string; search?: string; model?: string; status?: string; scope?: 'workbench' | 'library' }
export const getLocalHistory = (query: HistoryQuery = { limit: 12 }) => localRead<{ items: HistoryTask[]; total: number; unfilteredTotal: number }>('/api/nova/storage/tasks?' + new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])));
export const getHistoryTask = async (id: string) => (await localRead<{ task: HistoryTask }>('/api/nova/storage/tasks/' + encodeURIComponent(id))).task;
export const removeTaskDisplay = (id: string) => localRead<{removed:boolean;worksRetained:boolean}>('/api/nova/storage/tasks/' + encodeURIComponent(id) + '/remove', {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
export const removeHistoryTask = (id: string, deleteOutputs: boolean) => localRead<{ removed: boolean; deletedAssets: number; retainedAssets: number }>('/api/nova/storage/tasks/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleteOutputs }) });
export interface SubmissionIntent { localRequestId: string; input: WorkbenchTaskInput; createdAt: string; attemptStartedAt: string | null; taskId: string | null }
export const prepareSubmission = async (input: WorkbenchTaskInput) => (await localRead<{ input: WorkbenchTaskInput }>('/api/nova/storage/submissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).input;
export const markSubmissionAttempt = (id: string) => localRead('/api/nova/storage/submissions/' + encodeURIComponent(id) + '/attempt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
export const getSubmissions = async () => (await localRead<{ items: SubmissionIntent[] }>('/api/nova/storage/submissions')).items;
export const dismissSubmission = (id: string) => localRead('/api/nova/storage/submissions/' + encodeURIComponent(id), { method: 'DELETE' });
export async function importReference(file: File): Promise<AssetSummary> {
  return (await localRead<{ asset: AssetSummary }>('/api/nova/assets/import', { method: 'POST', headers: { 'content-type': file.type, 'x-nova-filename': encodeURIComponent(file.name) }, body: file })).asset;
}
export const PRESET_MODELS = ['gpt-image-2.5-flare', 'grok-imagine-video-6s', 'grok-imagine-video-1.5-6s'] as const;
export const OPENSOSEN_BASE = 'https://newapi.opensosen.com/v1';
export function validateBaseUrl(value: string): { canonical?: string; error?: string } {
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\s\\]|%2f|%5c/i.test(value)) throw Error();
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return { error: '非本机服务请使用 HTTPS。' };
    if (/\/(models|videos|images\/(generations|edits))\/?$/.test(url.pathname)) return { error: '请填写接口基础地址，不要填写 models、videos 或图片操作端点。' };
    const pathname = url.pathname.replace(/\/+$/, '') || '/v1';
    return { canonical: url.origin + pathname };
  } catch { return { error: '请输入不含用户名、密码、查询参数和片段的 HTTP(S) 基础地址。' }; }
}
export function connectionMessage(connection: import('./connection-client').ConnectionSummary | null, online = true) {
  if (!online) return '当前离线；草稿和本地作品仍可使用。';
  if (!connection) return '尚未配置生成服务。连接后即可生成图片和视频。';
  if (connection.credentialState === 'unavailable') return '无法解密已保存凭据，请重新填写 API Key。';
  if (!connection.hasCredential || connection.credentialState === 'missing') return '需要填写 API Key。';
  if (connection.validationState === 'verified' && (!connection.lastCheckedAt || Date.now() - Date.parse(connection.lastCheckedAt) > 300000)) return '最近检查记录已过期，请重新检查当前连接。模型缓存和本地作品仍保留。';
  const messages: Record<string, string> = {
    verified: '最近只读检查通过；模型可见不代表生成模式已验证。',
    unverified: '连接尚未验证。请执行只读连接检查。', offline: '暂时无法连接，请检查地址或网络后重试。',
    auth_rejected: '凭据需要更新：API Key 无效、已失效或无权访问模型接口。',
    models_unsupported: '此服务不支持模型列表接口；这不等于凭据无效。请核对服务协议。',
    models_invalid: '响应不是兼容的模型列表，请检查是否填成网站地址。', unavailable: '服务暂时不可用，请稍后重试。',
    redirect_rejected: '模型接口发生重定向，已停止检查，请核对基础地址。', unconfigured: '需要填写 API Key。',
  };
  return messages[connection.validationState] || '连接尚未验证。';
}
// A stale model-list check does not invalidate saved credentials.
export function connectionBanner(connection: import('./connection-client').ConnectionSummary | null, online = true): string | null {
  if (!connection || !connection.hasCredential || connection.credentialState !== 'ready') return connectionMessage(connection, true);
  if (!validateBaseUrl(connection.baseUrl).canonical) return '接口基础地址无效，请在设置中检查地址。';
  if (!online) return '当前网络离线，请恢复网络后重试；无需重新填写连接配置。';
  if (connection.validationState === 'auth_rejected') return '最近模型接口检查未通过鉴权，请在设置中核对权限或 Key；这不等于所有生成接口均不可用。';
  return null;
}
export function localErrorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : 'LOCAL_SERVICE_FAILED';
  const messages: Record<string, string> = {
    CONNECTION_VERSION_CONFLICT: '连接已在其他操作中更新，请重新读取设置。', CONNECTION_URL_INVALID: '接口基础地址无效。',
    CREDENTIAL_REQUIRED: '请填写 API Key；修改服务地址后也需要重新填写。', CREDENTIAL_UNAVAILABLE: '系统无法解密凭据，请重新填写 API Key。',
    CREDENTIAL_PROTECTION_UNAVAILABLE: 'Windows 系统保护暂不可用，未保存凭据。', CREDENTIAL_ENCRYPTION_FAILED: '凭据加密失败，未保存配置。',
    DIRECTORY_NOT_WRITABLE: '目录不可写或已失效，请重新选择文件夹。', DESKTOP_OPERATION_FAILED: '本机操作失败，已有配置和文件仍保留。',
    DRAFT_REVISION_CONFLICT: '草稿已被其他操作更新，未覆盖。请重新读取草稿。', SETTING_REVISION_CONFLICT: '设置已更新，请重新打开设置。',
    TOO_MANY_ASSETS: `本应用一次最多添加 ${MAX_REFERENCE_ASSETS} 张；已保留全部素材，请减少选择后再试。`, ASSET_TYPE_INVALID: '参考图支持 PNG、JPEG。', ASSET_SIZE_INVALID: '图片为空或超过应用的 100 MiB 导入限制。',
    CONNECTION_INPUT_INVALID: '连接参数无效，请检查名称、地址与型号。', CONNECTION_MODEL_INVALID: '请输入完整模型名。',
    CONNECTION_SERVICE_NOT_READY: '本机连接服务尚未就绪，请重试。',
    MODEL_UNAVAILABLE: '当前服务未列出此型号，请刷新列表或选择其他型号。',
    CAPABILITY_UNVERIFIED: '当前完整模型、模式或规格尚未验证，未提交生成。', INPUT_INVALID: '提示词、模式、规格或参考图不符合要求。',
    ASSET_MISSING: '本地文件缺失，任务记录仍保留。请重新导入参考图或核对结果。', ASSET_CORRUPT: '本地文件摘要不符，记录已保留。',
    AUTH_REJECTED: '原连接鉴权失败，请检查连接；旧任务不会改绑新 Key。', TASK_ACTIVE: '任务仍在本地执行，请先取消，等待取消确认后再移除。',
    SUBMISSION_ALREADY_ATTEMPTED: '该意图已尝试提交，请核对本地任务；不会再次发送创建请求。',
    TASK_CAPACITY_BUSY: '该类任务名额已满，请稍后重试下载。', INVALID_SETTING_VALUE: '任务控制必须填写范围内的整数。',
    SAVE_TARGET_CHANGED: '另存目标已变化，未覆盖。请重新另存。', FILE_BUSY: '文件被占用，请关闭占用程序后重试。', DISK_FULL: '磁盘空间不足，请清理后重试。',
  };
  return messages[code] || '本机服务操作失败，请重试。已有记录和文件仍保留。';
}
