'use client';
import { generateUUID } from '@/lib/uuid';
export type TransportRoute = 'cn' | 'com';
/** Optional only for summaries returned by an older host. */
export interface ConnectionRouteFields {
  routeSupported?: boolean; route?: TransportRoute | null; routeRevision?: number | null;
}
export interface ConnectionSummary extends ConnectionRouteFields {
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
  route?: TransportRoute;
  expectedRouteRevision?: number;
}
export interface ConnectionVersionInput { connectionId: string; expectedVersionId: string }
export interface ConnectionResult { ok: boolean; connection?: ConnectionSummary; code?: string }
export interface CapabilitySummary {
  capabilityVersionId: string; provider: string; baseUrl: string; model: string; mode: string; protocol: string;
  parameters: Record<string, unknown>; evidenceLevel: string; evidenceVersion: string; isCurrent?: boolean;
  evidence: { sourceIds: string[]; applicationVerified: boolean; referenceSemantics?: string; submissionPolicy?: string; supplierMaximumReferences?: number | null; configuredProtocol?: string; submissionEnabled?: boolean };
}
export interface ModelDisplaySettings {
  revision: number;
  imageModels: string[];
  videoModels: string[];
  defaultImageModel: string | null;
  defaultVideoModel: string | null;
  pricingGroup: string | null;
}
export interface ConnectionModels extends ConnectionRouteFields {
  displaySettings?: ModelDisplaySettings;
  pricingGroups?: string[];
  transportEvidence?: 'generation_unverified' | 'see_capability_evidence';
  connectionVersionId: string; modelsFetchedAt: string | null;
  models: Array<{model: string; visibility: 'visible' | 'absent' | 'unknown'; categories?: string[]; classificationSource?: string; endpointTypes?: string[]; custom?: boolean; submissionEnabled?: boolean; submissionEnabledByKind?: {image:boolean;video:boolean}}>;
  refreshError?: string | null;
  modelSettings?: Record<string,{categories?: string[];custom?: boolean;defaultSeconds?: number}>;
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
export const getConnection = (connectionId: string) => read<{connection: ConnectionSummary}>('/api/nova/connections/' + encodeURIComponent(connectionId)).then(value => value.connection);
/** Connection identity stays fixed when only the transport route changes. */
export function sameConnectionTransport(connection: ConnectionSummary, value: ConnectionModels): boolean {
  return value.connectionVersionId === connection.connectionVersionId && (connection.routeRevision == null || (value.routeRevision === connection.routeRevision && value.route === connection.route));
}
export const getConnectionModels = (connectionId: string) => read<ConnectionModels>('/api/nova/connections/' + encodeURIComponent(connectionId) + '/models');
export const checkConnection = (connection: ConnectionSummary, force = false, reason = 'manual') => read<ConnectionCheck>('/api/nova/connections/' + encodeURIComponent(connection.connectionId) + '/check', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({connectionVersionId: connection.connectionVersionId, ...(connection.routeRevision != null ? {expectedRouteRevision: connection.routeRevision} : {}), force, ...(reason==='manual'?{}:{reason})})});
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
const desktopIntents = new WeakMap<object, Promise<{localRequestId: string; connectionVersionId: string}>>();
/** Image and plugin/video clients share a stable local intent and immutable connection.
 * Reuse the input object or supply localRequestId when explicitly retrying a lost local ACK.
 * This local identifier is never an upstream idempotency guarantee.
 */
export async function desktopTaskPayload<T extends object>(input: T): Promise<Omit<T, 'apiKey' | 'baseUrl' | 'protocol'>> {
  const payload = {...input} as Record<string, unknown>;
  delete payload.apiKey; delete payload.baseUrl; delete payload.protocol; delete payload.credentialRef;
  let intent = desktopIntents.get(input);
  if (!intent) {
    intent = (async () => {
      const localRequestId = typeof payload['localRequestId'] === 'string' ? payload['localRequestId'] : generateUUID();
      if (typeof payload['connectionVersionId'] === 'string') return { localRequestId, connectionVersionId: payload['connectionVersionId'] };
      const connection = await getCurrentConnection();
      if (!connection?.hasCredential || connection.credentialState !== 'ready') throw new Error('请先保存可用的连接凭据。');
      return { localRequestId, connectionVersionId: connection.connectionVersionId };
    })();
    desktopIntents.set(input, intent);
    void intent.catch(() => desktopIntents.delete(input));
  }
  const fixed = await intent;
  payload['localRequestId'] ??= fixed.localRequestId;
  payload['connectionVersionId'] ??= fixed.connectionVersionId;
  return payload as Omit<T, 'apiKey' | 'baseUrl' | 'protocol'>;
}

export const saveModelSettings = (connection: ConnectionSummary, fields: {model:string;categories?:string[]|null;custom?:boolean;defaultSeconds?:number}) => read<ConnectionModels>('/api/nova/connections/'+encodeURIComponent(connection.connectionId)+'/model-settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({connectionVersionId:connection.connectionVersionId,...fields})});

/** Public fixed-per-image numbers; no currency or account-group inference. */
export interface ConnectionPricing {
  connectionVersionId: string; route: TransportRoute | null; routeRevision: number | null;
  model: string; group: string | null; displayRevision?: number; stale: boolean; cached: boolean; reason: string | null;
  estimate: { perImage: number } | null;
}
export const getConnectionPricing = (connectionId: string, signal?: AbortSignal, model?: string) =>
  read<ConnectionPricing>('/api/nova/connections/' + encodeURIComponent(connectionId) + '/pricing' + (model ? '?model=' + encodeURIComponent(model) : ''), { signal });
export const getModelDisplay = (connectionId: string) => read<ConnectionModels>('/api/nova/connections/' + encodeURIComponent(connectionId) + '/model-display');
export const saveModelDisplay = (connection: ConnectionSummary, value: ModelDisplaySettings) => read<ConnectionModels>('/api/nova/connections/' + encodeURIComponent(connection.connectionId) + '/model-display', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    connectionVersionId: connection.connectionVersionId, expectedRouteRevision: connection.routeRevision ?? null,
    expectedRevision: value.revision, imageModels: value.imageModels, videoModels: value.videoModels,
    defaultImageModel: value.defaultImageModel, defaultVideoModel: value.defaultVideoModel, pricingGroup: value.pricingGroup,
  }),
});
