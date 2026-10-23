import type { AssetSummary, WorkbenchTaskResponse } from './workbench-task-client';
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
export const getLocalHistory = () => localRead<{ items: Array<WorkbenchTaskResponse & { prompt: string; model: string }>; total: number }>('/api/nova/storage/tasks?limit=12');
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
export function localErrorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : 'LOCAL_SERVICE_FAILED';
  const messages: Record<string, string> = {
    CONNECTION_VERSION_CONFLICT: '连接已在其他操作中更新，请重新读取设置。', CONNECTION_URL_INVALID: '接口基础地址无效。',
    CREDENTIAL_REQUIRED: '请填写 API Key；修改服务地址后也需要重新填写。', CREDENTIAL_UNAVAILABLE: '系统无法解密凭据，请重新填写 API Key。',
    CREDENTIAL_PROTECTION_UNAVAILABLE: 'Windows 系统保护暂不可用，未保存凭据。', CREDENTIAL_ENCRYPTION_FAILED: '凭据加密失败，未保存配置。',
    DIRECTORY_NOT_WRITABLE: '目录不可写或已失效，请重新选择文件夹。', DESKTOP_OPERATION_FAILED: '本机操作失败，已有配置和文件仍保留。',
    DRAFT_REVISION_CONFLICT: '草稿已被其他操作更新，未覆盖。请重新读取草稿。', SETTING_REVISION_CONFLICT: '设置已更新，请重新打开设置。',
    ASSET_TYPE_INVALID: '参考图支持 PNG、JPEG。', ASSET_SIZE_INVALID: '图片为空或超过应用的 100 MiB 导入限制。',
    CONNECTION_INPUT_INVALID: '连接参数无效，请检查名称、地址与型号。', CONNECTION_MODEL_INVALID: '请输入完整模型名。',
    CONNECTION_SERVICE_NOT_READY: '本机连接服务尚未就绪，请重试。',
  };
  return messages[code] || '本机服务操作失败，请重试。已有记录和文件仍保留。';
}
