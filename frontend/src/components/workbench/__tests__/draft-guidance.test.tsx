import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftEditor, type SubmitBlocker } from '../DraftEditor';
import { generationPlan } from '@/lib/workbench-generation';
import type { ConnectionModels, ConnectionSummary, CapabilitySummary } from '@/lib/connection-client';
import type { AssetSummary } from '@/lib/workbench-task-client';
import type { Draft } from '@/lib/workbench-client';
import rules from '../../../../../backend/connections/model-rules.json';
const six = 'grok-imagine-video-1.5-6s', preview = 'grok-imagine-video-1.5-preview';
const connection: ConnectionSummary = { connectionId: 'guide-connection', connectionVersionId: 'guide-version', provider: rules.provider, baseUrl: rules.baseUrl, protocol: 'openai', displayName: 'synthetic', hasCredential: true, credentialState: 'ready', validationState: 'verified', lastCheckedAt: null, lastSuccessAt: null, modelsFetchedAt: null, errorCode: null, defaultImageModel: 'gpt-image-2.5-flare', defaultVideoModel: six, isDefault: true };
const capabilities: CapabilitySummary[] = Object.entries(rules.models).flatMap(([model, parameters]) => ['video.text', 'video.single_reference', 'video.dual_reference', 'video.multi_reference'].map(mode => ({ capabilityVersionId: model + mode, provider: rules.provider, baseUrl: rules.baseUrl, protocol: 'openai', model, mode, parameters, evidenceVersion: rules.version, evidenceLevel: 'unverified', evidence: { sourceIds: [], applicationVerified: false } })));
const models: ConnectionModels = { connectionVersionId: connection.connectionVersionId, modelsFetchedAt: null, models: [six, preview].map(model => ({ model, visibility: 'visible', categories: ['video'] })), capabilities };
const asset = (index: number): AssetSummary => ({ assetId: 'guide-image-' + index, kind: 'image', displayName: 'reference-' + index + '.png', mimeType: 'image/png', byteLength: 10, sha256: 'synthetic', availability: 'available', validationState: 'verified', previewUrl: '/synthetic-' + index + '.png' });
const initial: Draft = { mode: 'video.text', model: six, prompt: 'synthetic scene', parameters: {}, inputAssets: [], revision: 1, updatedAt: null };
type Overrides = Partial<React.ComponentProps<typeof DraftEditor>>;
const submit = vi.fn();
function editor(draft = initial, overrides: Overrides = {}) { return <DraftEditor draft={draft} connection={connection} models={models} saving={false} onChange={vi.fn()} onConfigure={vi.fn()} onRetry={vi.fn()} onReload={vi.fn()} onSubmit={submit} {...overrides} />; }
function Harness({ value = initial, overrides = {} }: { value?: Draft; overrides?: Overrides }) {
  const [draft, setDraft] = useState(value), [catalog, setCatalog] = useState(models);
  return editor(draft, { models: catalog, onChange: patch => setDraft(previous => ({ ...previous, ...patch })), onModels: setCatalog, ...overrides });
}
const guidance = () => screen.getByLabelText('生成条件');
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); submit.mockClear(); delete window.novaDesktop; });

it('duration uses the real effective default, editing is not auto-saving, and failed default saves can retry', async () => {
  let calls = 0;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls++; expect(JSON.parse(String(init?.body))).toEqual({ connectionVersionId: connection.connectionVersionId, model: six, defaultSeconds: 3 });
    return calls === 1 ? Response.json({ code: 'SYNTHETIC_FAILURE' }, { status: 503 }) : Response.json({ ...models, modelSettings: { [six]: { defaultSeconds: 3 } } });
  }); vi.stubGlobal('fetch', fetcher);
  render(<Harness />);
  expect(screen.getByText('默认 6 秒')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '已设为默认' })).toBeDisabled();
  fireEvent.change(screen.getByRole('spinbutton', { name: '视频时长（秒）' }), { target: { value: '3' } });
  expect(fetcher).not.toHaveBeenCalled(); expect(screen.getByText('默认 6 秒')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '设为默认' }));
  await screen.findByText('默认时长保存失败，请重试。');
  expect(screen.getByText('默认 6 秒')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '设为默认' }));
  await screen.findByText('已保存此型号的默认时长。');
  expect(screen.getByText('默认 3 秒')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '已设为默认' })).toBeDisabled();
  fireEvent.change(screen.getByRole('spinbutton', { name: '视频时长（秒）' }), { target: { value: '4' } });
  expect(screen.getByRole('button', { name: '设为默认' })).toBeEnabled();
  expect(screen.getByText('默认 3 秒')).toBeInTheDocument(); expect(calls).toBe(2);
  expect(submit).not.toHaveBeenCalled();
});
it('in-flight default saving prevents repeated requests and unconfirmed responses cannot mark a default', async () => {
  let release!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; })); vi.stubGlobal('fetch', fetcher);
  render(<Harness value={{ ...initial, parameters: { seconds: 3 } }} />);
  fireEvent.click(screen.getByRole('button', { name: '设为默认' }));
  fireEvent.click(screen.getByRole('button', { name: '保存中…' }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { release(Response.json(models)); });
  expect(screen.getByText('默认时长保存失败，请重试。')).toBeInTheDocument();
  expect(screen.getByText('默认 6 秒')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '设为默认' })).toBeEnabled();
});
it.each(['model', 'connection', 'route'] as const)('late default receipts cannot change the current %s scope', async scope => {
  let release!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const onModels = vi.fn(), value = { ...initial, parameters: { seconds: 3 } };
  const view = render(editor(value, { onModels }));
  fireEvent.click(screen.getByRole('button', { name: '设为默认' }));
  const nextConnection = scope === 'connection' ? { ...connection, connectionVersionId: 'new-version' } : scope === 'route' ? { ...connection, routeSupported: true, route: 'com' as const, routeRevision: 2 } : connection;
  const nextModels = { ...models, connectionVersionId: nextConnection.connectionVersionId, ...(scope === 'route' ? { route: 'com' as const, routeRevision: 2 } : {}) };
  view.rerender(editor({ ...value, model: scope === 'model' ? preview : six }, { connection: nextConnection, models: nextModels, onModels }));
  expect(screen.getByText(scope === 'model' ? '默认 10 秒' : '默认 6 秒')).toBeInTheDocument();
  await act(async () => { release(Response.json({ ...models, modelSettings: { [six]: { defaultSeconds: 3 } } })); });
  expect(onModels).not.toHaveBeenCalled(); expect(screen.queryByText('默认 3 秒')).not.toBeInTheDocument();
  expect(screen.queryByText('已保存此型号的默认时长。')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '设为默认' })).toBeEnabled();
});
it('invalid stored defaults use the configured fallback while a valid saved default is shown', () => {
  const view = render(editor({ ...initial, parameters: { seconds: 3 } }, { models: { ...models, modelSettings: { [six]: { defaultSeconds: 0 } } } }));
  expect(screen.getByText('默认 6 秒')).toBeInTheDocument();
  view.rerender(editor({ ...initial, parameters: { seconds: 3 } }, { models: { ...models, modelSettings: { [six]: { defaultSeconds: 3 } } } }));
  expect(screen.getByText('默认 3 秒')).toBeInTheDocument(); expect(screen.getByRole('button', { name: '已设为默认' })).toBeDisabled();
});

it('one source lists missing prompt and precise missing references together without relaxing capability gates', () => {
  for (const [count, missing] of [[0, 2], [1, 1]]) {
    const plan = generationPlan({ ...initial, mode: 'video.dual_reference', prompt: '', inputAssets: Array.from({ length: count }, (_, index) => asset(index)) }, connection, models);
    expect(plan.issues.map(issue => issue.code)).toEqual(['prompt', 'references-missing']);
    expect(plan.issues[1].message).toContain('还需添加 ' + missing + ' 张');
    expect(plan.blocked).toBe(plan.issues[0].message);
  }
  for (const count of [2, 7]) expect(generationPlan({ ...initial, mode: 'video.dual_reference', inputAssets: Array.from({ length: count }, (_, index) => asset(index)) }, connection, models).issues).toEqual([]);
  const unknown = generationPlan({ ...initial, mode: 'video.dual_reference', inputAssets: [asset(0), asset(1)] }, connection, { ...models, capabilities: [] });
  expect(unknown.issues.map(issue => issue.code)).toEqual(['capability']);
  expect(unknown.blocked).not.toBe('');
  expect(generationPlan({ ...initial, mode: 'video.dual_reference', inputAssets: Array.from({ length: 8 }, (_, index) => asset(index)) }, connection, models).issues.some(issue => issue.code === 'references-excess')).toBe(true);
});
it('single-reference requires exactly one, and broken or excess references retain explicit review actions', () => {
  expect(generationPlan({ ...initial, mode: 'video.single_reference' }, connection, models).issues[0].code).toBe('references-missing');
  expect(generationPlan({ ...initial, mode: 'video.single_reference', inputAssets: [asset(0)] }, connection, models).issues).toEqual([]);
  const missing = { ...asset(1), availability: 'missing' as const };
  const value = { ...initial, mode: 'video.single_reference' as const, inputAssets: [asset(0), missing] }, onChange = vi.fn();
  render(editor(value, { onChange }));
  expect(guidance()).toHaveTextContent('当前模式需要 1 张参考图');
  expect(guidance()).toHaveTextContent('参考图缺失或损坏');
  expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled();
  fireEvent.click(within(guidance()).getAllByRole('button', { name: '查看参考图' })[0]);
  expect(document.activeElement).toBe(screen.getByLabelText('参考图片区域'));
  expect(onChange).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});
it('missing prompt action scrolls/focuses the actual textarea and filling it never generates automatically', () => {
  render(<Harness value={{ ...initial, prompt: '' }} />);
  expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled();
  fireEvent.click(within(guidance()).getByRole('button', { name: '去填写' }));
  expect(document.activeElement).toBe(screen.getByLabelText('剧情描述'));
  fireEvent.change(screen.getByLabelText('剧情描述'), { target: { value: 'filled' } });
  expect(screen.queryByLabelText('生成条件')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '生成视频' })).toBeEnabled(); expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '生成视频' })); expect(submit).toHaveBeenCalledOnce();
});
it('add/continue actions reuse the importer, show busy as waiting, and never auto-submit after import', async () => {
  let finish!: (value: unknown) => void;
  const importer = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  Object.defineProperty(window, 'novaDesktop', { configurable: true, value: { importReferenceAssets: importer } });
  render(<Harness value={{ ...initial, mode: 'video.dual_reference' }} />);
  expect(guidance()).toHaveTextContent('还需添加 2 张');
  fireEvent.click(within(guidance()).getByRole('button', { name: '添加参考图' }));
  expect(guidance()).toHaveTextContent('正在导入参考图，完成后可生成。');
  expect(within(guidance()).queryByRole('button')).not.toBeInTheDocument();
  await act(async () => { finish({ ok: true, assets: [asset(0)] }); });
  expect(guidance()).toHaveTextContent('还需添加 1 张');
  fireEvent.click(within(guidance()).getByRole('button', { name: '继续添加' }));
  await act(async () => { finish({ ok: true, assets: [asset(1)] }); });
  expect(importer).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '生成视频' })).toBeEnabled(); expect(submit).not.toHaveBeenCalled();
});
it('browser add action opens the existing file input and legacy text-video references remain removable', () => {
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  const view = render(editor({ ...initial, mode: 'video.single_reference' }));
  fireEvent.click(within(guidance()).getByRole('button', { name: '添加参考图' })); expect(click).toHaveBeenCalledOnce();
  view.rerender(editor({ ...initial, inputAssets: [asset(0)] }));
  expect(screen.getByLabelText('参考图片区域')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '移除参考图 1' })).toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
});
it('invalid duration has a real focus action and valid editing preserves the configured price', () => {
  render(<Harness value={{ ...initial, parameters: { seconds: 0 } }} />);
  fireEvent.click(within(guidance()).getByRole('button', { name: '调整时长' }));
  expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: '视频时长（秒）' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: '视频时长（秒）' }), { target: { value: '3' } });
  expect(screen.getByText('¥0.15')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '生成视频' })).toBeEnabled(); expect(submit).not.toHaveBeenCalled();
});
it.each([
  [{ saving: true }, '正在保存草稿'],
  [{ error: Error('synthetic') }, '草稿尚未保存成功'],
  [{ submitting: true }, '正在建立本地任务，请稍候'],
  [{ submitDisabled: true }, '当前暂不能提交，请先核对本地任务状态'],
  [{ onSubmit: undefined }, '生成入口尚未就绪'],
] as Array<[Overrides, string]>)('every runtime disabled condition has a visible reason', (overrides, reason) => {
  const view = render(editor(initial, overrides));
  expect(view.container.querySelector('.wb-editor-footer button.wb-primary')).toBeDisabled();
  expect(guidance()).toHaveTextContent(reason);
});
it('parent blockers expose their actual independent causes and their actions do not invoke submit', () => {
  const recover = vi.fn(), prepare = vi.fn(), inspect = vi.fn();
  const blockers: SubmitBlocker[] = [
    { code: 'recovery', message: '提交记录正在核对', actionLabel: '核对提交记录', onAction: recover },
    { code: 'already', message: '此草稿已提交', actionLabel: '准备新任务', onAction: prepare },
    { code: 'intent', message: '尚有未解决提交意图', actionLabel: '核对本地任务', onAction: inspect },
  ];
  render(editor(initial, { submitDisabled: true, submitBlockers: blockers }));
  for (const item of blockers) { expect(guidance()).toHaveTextContent(item.message); fireEvent.click(within(guidance()).getByRole('button', { name: item.actionLabel })); }
  expect(recover).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce(); expect(inspect).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});
it('missing connection directs to configuration, without fabricated history-parameter errors', () => {
  const configure = vi.fn(); render(editor({ ...initial, prompt: '' }, { connection: null, models: null, onConfigure: configure }));
  expect(guidance()).toHaveTextContent('请先配置可用的连接凭据');
  expect(guidance()).toHaveTextContent('请填写提示词');
  expect(guidance()).not.toHaveTextContent('历史规格');
  fireEvent.click(within(guidance()).getByRole('button', { name: '配置连接' }));
  expect(configure).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
});

it('configuration remains available during draft autosave because it never starts generation', () => {
  const configure = vi.fn();
  render(editor(initial, { connection: null, models: null, saving: true, onConfigure: configure }));
  const button = screen.getByRole('button', { name: '配置连接后生成' });
  expect(button).toBeEnabled(); fireEvent.click(button);
  expect(configure).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
});

it('a response missing the saved setting cannot confirm the configured fallback as a successful save', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
  render(editor({ ...initial, parameters: { seconds: 6 } }, { models: { ...models, modelSettings: { [six]: { defaultSeconds: 3 } } } }));
  fireEvent.click(screen.getByRole('button', { name: '设为默认' }));
  await screen.findByText('默认时长保存失败，请重试。');
  expect(screen.getByText('默认 3 秒')).toBeInTheDocument();
  expect(screen.queryByText('已保存此型号的默认时长。')).not.toBeInTheDocument();
});
