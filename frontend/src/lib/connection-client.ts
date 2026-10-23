'use client';
export interface ConnectionSummary {
  connectionId: string;
  connectionVersionId: string;
  displayName: string;
  baseUrl: string;
  provider: string;
  protocol: 'openai';
  hasCredential: boolean;
  credentialState: 'ready' | 'missing' | 'unavailable';
  validationState: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  modelsFetchedAt: string | null;
  errorCode: string | null;
  defaultImageModel: string;
  defaultVideoModel: string;
  isDefault: boolean;
}
export interface SaveConnectionInput {
  connectionId?: string;
  expectedVersionId?: string;
  displayName?: string;
  baseUrl?: string;
  provider?: 'opensosen' | 'openai-compatible';
  /** Transient save input only. Never written to browser storage. */
  apiKey?: string;
  defaultImageModel?: string;
  defaultVideoModel?: string;
}
export interface ConnectionVersionInput { connectionId: string; expectedVersionId: string }
export interface ConnectionResult { ok: boolean; connection?: ConnectionSummary; code?: string }
export interface CapabilitySummary {
  capabilityVersionId: string; provider: string; baseUrl: string; model: string; mode: string; protocol: string;
  parameters: Record<string, unknown>; evidenceLevel: string; evidenceVersion: string;
  evidence: { sourceIds: string[]; applicationVerified: boolean; referenceSemantics?: string };
}
export interface ConnectionModels {
  connectionVersionId: string; modelsFetchedAt: string | null;
  models: Array<{model: string; visibility: 'visible' | 'absent' | 'unknown'}>;
  capabilities: CapabilitySummary[];
}
export interface ConnectionCheck extends Partial<ConnectionModels> {
  stale: boolean; cached: boolean; connection?: ConnectionSummary;
}
export const isDesktopConnectionMode = () => typeof window !== 'undefined' && Boolean(window.novaDesktop);
async function read<T>(route: string, options?: RequestInit): Promise<T> {
  const response = await fetch(route, {cache: 'no-store', ...options});
  const value = await response.json();
  if (!response.ok) throw new Error(value.code || 'CONNECTION_OPERATION_FAILED');
  return value as T;
}
export async function getCurrentConnection(): Promise<ConnectionSummary | null> {
  return (await read<{connection: ConnectionSummary | null}>('/api/nova/connections/current')).connection;
}
export const getConnectionModels = (connectionId: string) => read<ConnectionModels>('/api/nova/connections/' + encodeURIComponent(connectionId) + '/models');
export const checkConnection = (connection: ConnectionSummary, force = false) => read<ConnectionCheck>('/api/nova/connections/' + encodeURIComponent(connection.connectionId) + '/check', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({connectionVersionId: connection.connectionVersionId, force})});
export async function saveConnection(input: SaveConnectionInput): Promise<ConnectionSummary> {
  const transient = {...input};
  try {
    const result = await window.novaDesktop?.saveConnection(transient);
    if (!result?.ok || !result.connection) throw new Error(result?.code || 'CONNECTION_SERVICE_NOT_READY');
    return result.connection;
  } finally { delete transient.apiKey; }
}
export async function clearConnectionCredential(input: ConnectionVersionInput): Promise<ConnectionSummary> {
  const result = await window.novaDesktop?.clearConnectionCredential(input);
  if (!result?.ok || !result.connection) throw new Error(result?.code || 'CONNECTION_SERVICE_NOT_READY');
  return result.connection;
}
export async function selectConnection(input: ConnectionVersionInput): Promise<ConnectionSummary> {
  const result = await window.novaDesktop?.selectConnection(input);
  if (!result?.ok || !result.connection) throw new Error(result?.code || 'CONNECTION_SERVICE_NOT_READY');
  return result.connection;
}
/** Image and plugin/video clients share this one connection/version path. */
export async function desktopTaskPayload<T extends object>(input: T): Promise<Omit<T, 'apiKey' | 'baseUrl' | 'protocol'>> {
  const payload = {...input} as Record<string, unknown>;
  delete payload.apiKey; delete payload.baseUrl; delete payload.protocol; delete payload.credentialRef;
  if (!payload['connectionVersionId']) {
    const connection = await getCurrentConnection();
    if (!connection?.hasCredential || connection.credentialState !== 'ready') throw new Error('请先保存可用的连接凭据。');
    payload['connectionVersionId'] = connection.connectionVersionId;
  }
  return payload as Omit<T, 'apiKey' | 'baseUrl' | 'protocol'>;
}
