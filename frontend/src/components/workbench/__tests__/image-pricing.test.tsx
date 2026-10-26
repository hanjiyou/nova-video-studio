import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ImagePrice } from '../ImagePrice';
import { DraftEditor } from '../DraftEditor';
import { getConnectionPricing, type ConnectionPricing, type ConnectionModels, type ConnectionSummary, type CapabilitySummary } from '@/lib/connection-client';
import type { Draft } from '@/lib/workbench-client';
import policy from '../../../../../backend/tasks/image-policy.json';
import videoRules from '../../../../../backend/connections/model-rules.json';

const connection: ConnectionSummary = {
  connectionId: 'pricing-connection', connectionVersionId: 'pricing-version', baseUrl: policy.baseUrl,
  provider: 'opensosen', protocol: 'openai', displayName: 'synthetic', hasCredential: true, credentialState: 'ready',
  validationState: 'verified', lastCheckedAt: null, lastSuccessAt: null, modelsFetchedAt: null, errorCode: null,
  defaultImageModel: policy.model, defaultVideoModel: 'grok-imagine-video-1.5-6s', isDefault: true,
  routeSupported: true, route: 'cn', routeRevision: 1,
};
const quote = (overrides: Partial<ConnectionPricing> = {}): ConnectionPricing => ({
  connectionVersionId: connection.connectionVersionId, route: 'cn', routeRevision: 1, model: policy.model,
  group: '【生图分组】Image2原生-中质量', stale: false, cached: false, reason: null, estimate: { perImage: 0.12 }, ...overrides,
});
const minimum: CapabilitySummary = {
  capabilityVersionId: 'minimum', provider: policy.provider, baseUrl: policy.baseUrl, model: policy.model, mode: 'image.text', protocol: 'openai',
  parameters: {}, evidenceLevel: 'application_verified', evidenceVersion: 'synthetic-minimum', isCurrent: true,
  evidence: { sourceIds: ['synthetic'], applicationVerified: true },
};
const specs: CapabilitySummary = {
  ...minimum, capabilityVersionId: 'specs', parameters: { sizes: policy.sizes, qualities: policy.qualities, encoding: 'json', referenceCount: 0 },
  evidenceVersion: policy.evidenceVersion, evidenceLevel: 'unverified', isCurrent: false,
  evidence: { sourceIds: [], applicationVerified: false, submissionPolicy: policy.submissionPolicy },
};
const models: ConnectionModels = {
  connectionVersionId: connection.connectionVersionId, modelsFetchedAt: null,
  models: [{ model: policy.model, visibility: 'visible' }, { model: 'other-image', visibility: 'visible', categories: ['image'] }],
  capabilities: [minimum, specs],
};
const initial: Draft = { mode: 'image.text', model: policy.model, prompt: 'synthetic image', parameters: {}, inputAssets: [], revision: 1, updatedAt: null };
function Editor({ catalog = models }: { catalog?: ConnectionModels }) {
  const [draft, setDraft] = useState(initial);
  return <DraftEditor draft={draft} connection={connection} models={catalog} saving={false} onChange={patch => setDraft(value => ({ ...value, ...patch }))} onConfigure={() => {}} onReload={() => {}} onRetry={() => {}} onSubmit={() => {}} />;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('pricing client uses a read-only local GET with no credentials or upstream host', async () => {
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json(quote()));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  expect(await getConnectionPricing('a/b', controller.signal)).toEqual(quote());
  expect(fetcher).toHaveBeenCalledWith('/api/nova/connections/a%2Fb/pricing', { cache: 'no-store', signal: controller.signal });
});

it('medium reference design shows a numeric per-image price and keeps size, quality and generation unchanged', async () => {
  const fetcher = vi.fn(async () => Response.json(quote())); vi.stubGlobal('fetch', fetcher);
  render(<Editor />);
  const price = screen.getByLabelText('图片费用估算');
  expect(within(price).getByText('正在估算…')).toBeInTheDocument();
  await within(price).findByText('0.12/张');
  expect(within(price).getByText('中质量参考价')).toBeInTheDocument();
  expect(within(price).getByText('本次 1 张 · 参考费用 0.12')).toBeInTheDocument();
  expect(screen.queryByLabelText('报价分组')).not.toBeInTheDocument();
  expect(price.textContent).not.toMatch(/[¥$]/);
  expect(price).toHaveTextContent('按中质量分组报价，实际扣费以服务结算为准。');
  fireEvent.change(screen.getByLabelText('图片尺寸'), { target: { value: '1024x1024' } });
  fireEvent.change(screen.getByLabelText('图片质量'), { target: { value: 'max' } });
  expect(within(price).getByText('0.12/张')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/^图片规格与参考图编辑尚未在当前中转实测/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('生成模型'), { target: { value: 'other-image' } });
  expect(price).toHaveTextContent('暂无法估算');
  expect(price).not.toHaveTextContent('0.12');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('base-price updates and fine fractional numbers format without currency conversion', async () => {
  for (const [perImage, expected] of [[0.12, '0.12/张'], [0.24, '0.24/张'], [0.005000000000000001, '0.005/张'], [0, '0/张'], [0.30000000000000004, '0.3/张']] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(quote({ estimate: { perImage } }))));
    const view = render(<ImagePrice connection={connection} model={policy.model} />);
    await screen.findByText(expected, { selector: 'strong' });
    view.unmount();
  }
});

it('pricing failure never disables generation, and a model refresh rereads the local quote', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => { calls++; if (calls === 1) throw Error('synthetic failure'); return Response.json(quote()); }));
  const view = render(<Editor />);
  await screen.findByText('价格暂不可用，可刷新模型列表重试。');
  expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '重试估价' })).not.toBeInTheDocument();
  view.rerender(<Editor catalog={{ ...models, modelsFetchedAt: 'new-model-snapshot' }} />);
  await screen.findByText('0.12/张', { selector: 'strong' });
  expect(calls).toBe(2); expect(connection.validationState).toBe('verified');
});
it('a failed model snapshot with the same successful timestamp also rereads price and hides the old successful quote', async () => {
  const responses: Array<(value: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { responses.push(resolve); })));
  const current = { ...models, modelsFetchedAt: 'same-success-time' };
  const view = render(<ImagePrice connection={connection} model={policy.model} models={current} />);
  await act(async () => { responses[0](Response.json(quote())); });
  expect(screen.getByText('0.12/张', { selector: 'strong' })).toBeInTheDocument();
  view.rerender(<ImagePrice connection={connection} model={policy.model} models={{ ...current, refreshError: 'CONNECTION_UNAVAILABLE' }} />);
  expect(screen.getByText('正在估算…')).toBeInTheDocument();
  expect(screen.queryByText('0.12/张', { selector: 'strong' })).not.toBeInTheDocument();
  await act(async () => { responses[1](Response.json(quote({ estimate: null, reason: 'PRICING_UNAVAILABLE' }))); });
  expect(screen.getByText('暂无法估算')).toBeInTheDocument();
});
it('route and connection changes ignore late results and never flash the previous quote', async () => {
  const responses: Array<(value: Response) => void> = [];
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { responses.push(resolve); })); vi.stubGlobal('fetch', fetcher);
  const view = render(<ImagePrice connection={connection} model={policy.model} />);
  view.rerender(<ImagePrice connection={{ ...connection, route: 'com', routeRevision: 2 }} model={policy.model} />);
  await act(async () => { responses[1](Response.json(quote({ route: 'com', routeRevision: 2, estimate: { perImage: 0.24 } }))); });
  expect(screen.getByText('0.24/张', { selector: 'strong' })).toBeInTheDocument();
  await act(async () => { responses[0](Response.json(quote())); });
  expect(screen.queryByText('0.12/张', { selector: 'strong' })).not.toBeInTheDocument();
  view.rerender(<ImagePrice connection={{ ...connection, connectionVersionId: 'new-version', route: 'com', routeRevision: 2 }} model={policy.model} />);
  expect(screen.getByText('正在估算…')).toBeInTheDocument();
  expect(screen.queryByText('0.24/张', { selector: 'strong' })).not.toBeInTheDocument();
  await act(async () => { responses[2](Response.json(quote({ connectionVersionId: 'new-version', route: 'com', routeRevision: 2 }))); });
  expect(screen.getByText('0.12/张', { selector: 'strong' })).toBeInTheDocument();
});
it('unknown model, stale/mismatched response and unmount cannot retain or accept a quote', async () => {
  let release!: (value: Response) => void, signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => { signal = init?.signal as AbortSignal; return new Promise<Response>(resolve => { release = resolve; }); }));
  const view = render(<ImagePrice connection={connection} model={policy.model} />);
  view.rerender(<ImagePrice connection={connection} model="other-image" />);
  expect(signal?.aborted).toBe(true);
  await act(async () => { release(Response.json(quote())); });
  expect(screen.getByText('暂无法估算')).toBeInTheDocument();
  expect(screen.queryByText('0.12/张', { selector: 'strong' })).not.toBeInTheDocument();
  view.rerender(<ImagePrice connection={connection} model={policy.model} />);
  await act(async () => { release(Response.json(quote({ stale: true }))); });
  expect(screen.getByText('暂无法估算')).toBeInTheDocument();
  view.rerender(<ImagePrice connection={{ ...connection, routeRevision: 2 }} model={policy.model} />);
  await act(async () => { release(Response.json(quote())); });
  expect(screen.getByText('暂无法估算')).toBeInTheDocument();
  view.rerender(<ImagePrice connection={{ ...connection, routeRevision: 3 }} model={policy.model} />);
  view.unmount(); expect(signal?.aborted).toBe(true);
  await act(async () => { release(Response.json(quote())); });
});
it('invalid or missing pricing reports a short reason and exact custom connections make no request', async () => {
  const fetcher = vi.fn(async () => Response.json(quote({ estimate: null, reason: 'GROUP_PRICING_INVALID' })));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ImagePrice connection={connection} model={policy.model} />);
  await screen.findByText('暂无中质量分组报价。');
  view.rerender(<ImagePrice connection={{ ...connection, baseUrl: 'https://other.invalid/v1' }} model={policy.model} />);
  expect(screen.getByText('当前连接暂不支持图片估价。')).toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('video retains the existing per-second quotation and never loads image prices', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const model = 'grok-imagine-video-1.5-6s';
  const capability: CapabilitySummary = { ...minimum, capabilityVersionId: 'video', model, mode: 'video.text', parameters: videoRules.models[model], evidenceVersion: videoRules.version, evidenceLevel: 'unverified', evidence: { sourceIds: [], applicationVerified: false } };
  render(<DraftEditor draft={{ ...initial, mode: 'video.text', model }} connection={connection} models={{ ...models, capabilities: [capability] }} saving={false} onChange={() => {}} onConfigure={() => {}} onRetry={() => {}} onReload={() => {}} onSubmit={() => {}} />);
  expect(screen.getByText('¥0.30')).toBeInTheDocument();
  expect(screen.getByText('6 秒 × ¥0.05/秒')).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
});
