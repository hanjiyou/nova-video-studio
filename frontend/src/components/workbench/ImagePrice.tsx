'use client';
import { useEffect, useState } from 'react';
import { getConnectionPricing, type ConnectionModels, type ConnectionPricing, type ConnectionSummary } from '@/lib/connection-client';

const MODEL = 'gpt-image-2.5-flare';
const GROUP = '【生图分组】Image2原生-中质量';
const BASES = ['https://newapi.opensosen.cn/v1', 'https://newapi.opensosen.com/v1'];
const format = (value: number) => Number(value.toPrecision(12)).toString();
const reasons: Record<string, string> = {
  MODEL_NOT_PRICED: '当前型号暂无报价。',
  BILLING_UNSUPPORTED: '当前计费规则暂不支持估算。',
  GROUP_PRICING_INVALID: '暂无中质量分组报价。',
  PRICING_INVALID: '价格资料格式异常。',
};

export function ImagePrice({ connection, model, models = null }: { connection: ConnectionSummary | null; model: string; models?: ConnectionModels | null }) {
  const connectionId = connection?.connectionId, versionId = connection?.connectionVersionId;
  const route = connection?.route, revision = connection?.routeRevision;
  const supported = model === MODEL && connection?.provider === 'opensosen' &&
    BASES.includes(connection.baseUrl) && connection.routeSupported === true &&
    (route === 'cn' || route === 'com') && Number.isSafeInteger(revision) && Number(revision) > 0;
  const key = JSON.stringify([connectionId, versionId, route, revision, model, models?.modelsFetchedAt, models?.refreshError]);
  const [state, setState] = useState<{ key: string; loading: boolean; value?: ConnectionPricing }>({ key: '', loading: true });
  useEffect(() => {
    if (!supported || !connectionId) return;
    let ignore = false;
    const controller = new AbortController();
    setState({ key, loading: true });
    void getConnectionPricing(connectionId, controller.signal).then(value => {
      if (ignore) return;
      if (value.stale || value.connectionVersionId !== versionId || value.route !== route || value.routeRevision !== revision || value.model !== model || value.group !== GROUP)
        setState({ key, loading: false });
      else setState({ key, loading: false, value });
    }).catch(() => { if (!ignore) setState({ key, loading: false }); });
    return () => { ignore = true; controller.abort(); };
    // A new model snapshot also covers failed refreshes with an unchanged modelsFetchedAt.
    // This GET initializes once per scope; later reads cannot refresh the public source.
  }, [connectionId, versionId, route, revision, model, supported, key, models]);
  const current = state.key === key ? state : { key, loading: true };
  const loading = supported && current.loading;
  const estimate = supported && !loading ? current.value?.estimate : null;
  const perImage = estimate?.perImage;
  const amount = typeof perImage === 'number' && Number.isFinite(perImage) && perImage >= 0 ? format(perImage) : null;
  const reason = !connection ? '配置连接后可读取价格。' : model !== MODEL ? '当前型号暂无可用的按张估价。' :
    !supported ? '当前连接暂不支持图片估价。' : reasons[current.value?.reason || ''] || '价格暂不可用，可刷新模型列表重试。';
  return <div className="wb-generation-price" aria-label="图片费用估算" aria-live="polite">
    <span>中质量参考价</span><strong>{loading ? '正在估算…' : amount !== null ? amount + '/张' : '暂无法估算'}</strong>
    {amount !== null ? <small>本次 1 张 · 参考费用 {amount}</small> : !loading && <small>{reason}</small>}
    {model === MODEL && <small>按中质量分组报价，实际扣费以服务结算为准。</small>}
  </div>;
}
