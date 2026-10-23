import { checkConnection, getCurrentConnection, isDesktopConnectionMode } from '@/lib/connection-client';
import { parseUpstreamModelList } from '@/lib/provider-registry';

export async function fetchUpstreamModels(input: {
  baseUrl: string;
  apiKey: string;
  protocol: string;
}): Promise<string[]> {
  if (isDesktopConnectionMode()) {
    const connection = await getCurrentConnection();
    if (!connection) throw new Error('请先保存连接。');
    const checked = await checkConnection(connection, true);
    if (checked.stale) throw new Error('连接已变更，请重新检查。');
    if (checked.connection?.validationState !== 'verified') throw new Error(checked.connection?.errorCode || 'CONNECTION_UNAVAILABLE');
    return (checked.models || []).filter(model => model.visibility === 'visible').map(model => model.model);
  }
  const response = await fetch('/api/nova/proxy/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      apiKey: input.apiKey,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(readProxyError(detail, response.status));
  }
  return parseUpstreamModelList(await response.json());
}

function readProxyError(detail: string, status: number): string {
  const fallback = `读取模型列表失败（${status}）`;
  const raw = String(detail || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    if (parsed.error && typeof parsed.error === 'object' && typeof (parsed.error as { message?: unknown }).message === 'string') {
      return String((parsed.error as { message: string }).message);
    }
  } catch {
    if (!raw.startsWith('<')) return raw.slice(0, 180);
  }
  return fallback;
}
