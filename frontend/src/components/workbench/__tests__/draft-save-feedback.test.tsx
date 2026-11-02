import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { DraftEditor } from '../DraftEditor';
import type { CapabilitySummary, ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import type { Draft } from '@/lib/workbench-client';
import rules from '../../../../../backend/connections/model-rules.json';

const model = 'grok-imagine-video-1.5-6s';
const connection: ConnectionSummary = { connectionId: 'feedback-connection', connectionVersionId: 'feedback-version', provider: rules.provider, baseUrl: rules.baseUrl, protocol: 'openai', displayName: 'synthetic', hasCredential: true, credentialState: 'ready', validationState: 'verified', lastCheckedAt: null, lastSuccessAt: null, modelsFetchedAt: null, errorCode: null, defaultImageModel: 'gpt-image-2.5-flare', defaultVideoModel: model, isDefault: true };
const capability: CapabilitySummary = { capabilityVersionId: 'feedback-video', provider: rules.provider, baseUrl: rules.baseUrl, protocol: 'openai', model, mode: 'video.text', parameters: rules.models[model], evidenceVersion: rules.version, evidenceLevel: 'unverified', evidence: { sourceIds: [], applicationVerified: false } };
const models: ConnectionModels = { connectionVersionId: connection.connectionVersionId, modelsFetchedAt: null, models: [{ model, visibility: 'visible', categories: ['video'] }], capabilities: [capability] };
const draft: Draft = { mode: 'video.text', model, prompt: '持续输入的剧情描述', parameters: {}, inputAssets: [], revision: 1, updatedAt: null };
const submit = vi.fn(), retry = vi.fn();
function editor(overrides: Partial<ComponentProps<typeof DraftEditor>> = {}) {
  return <DraftEditor draft={draft} connection={connection} models={models} saving={false} onChange={vi.fn()} onConfigure={vi.fn()} onRetry={retry} onReload={vi.fn()} onSubmit={submit} {...overrides} />;
}
const status = () => screen.getByLabelText('草稿保存状态');
const generate = () => screen.getByRole('button', { name: '生成视频' });
beforeEach(() => { vi.useFakeTimers(); submit.mockReset(); retry.mockReset(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps fast saves quiet while preserving the immediate generation guard', () => {
  const view = render(editor());
  expect(generate()).toBeEnabled();
  const footer = view.container.querySelector('.wb-editor-footer')!;
  const text = footer.textContent;
  view.rerender(editor({ saving: true }));
  expect(status()).toHaveTextContent('草稿自动保存');
  expect(status()).toHaveAttribute('aria-busy', 'true');
  expect(generate()).toBeDisabled();
  expect(generate()).toHaveAccessibleDescription('草稿自动保存');
  expect(screen.queryByLabelText('生成条件')).not.toBeInTheDocument();
  expect(footer.textContent).toBe(text);
  fireEvent.click(generate()); expect(submit).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(100));
  view.rerender(editor());
  expect(status()).toHaveTextContent('草稿自动保存');
  expect(generate()).toBeEnabled();
  expect(footer.textContent).toBe(text);
});

it('does not insert or change the bottom message during repeated short saves while typing', () => {
  const view = render(editor());
  const prompt = screen.getByLabelText('剧情描述'); prompt.focus();
  const footer = view.container.querySelector('.wb-editor-footer')!, hint = footer.querySelector('p'), text = footer.textContent;
  for (let index = 0; index < 12; index++) {
    const current = { ...draft, prompt: draft.prompt + '内容'.repeat(index) };
    view.rerender(editor({ draft: current, saving: true }));
    act(() => vi.advanceTimersByTime(120));
    view.rerender(editor({ draft: current }));
    act(() => vi.advanceTimersByTime(30));
    expect(status()).toHaveTextContent('草稿自动保存');
    expect(footer.querySelector('p')).toBe(hint);
    expect(footer.textContent).toBe(text);
    expect(screen.queryByLabelText('生成条件')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(prompt);
  }
  expect(submit).not.toHaveBeenCalled();
});

it('shows a slow save after 800ms in the fixed status area and never expands the footer', () => {
  const view = render(editor({ saving: true }));
  const footer = view.container.querySelector('.wb-editor-footer')!, text = footer.textContent;
  act(() => vi.advanceTimersByTime(799));
  expect(status()).toHaveTextContent('草稿自动保存');
  act(() => vi.advanceTimersByTime(1));
  expect(status()).toHaveTextContent('正在保存草稿…');
  expect(generate()).toBeDisabled();
  expect(generate()).toHaveAccessibleDescription('正在保存草稿…');
  expect(screen.queryByLabelText('生成条件')).not.toBeInTheDocument();
  expect(footer.textContent).toBe(text);
  view.rerender(editor());
  expect(status()).toHaveTextContent('草稿自动保存');
  expect(generate()).toBeEnabled();
});

it('keeps real validation guidance and its actions stable while background saving starts or stops', () => {
  const empty = { ...draft, prompt: '' }, view = render(editor({ draft: empty }));
  const guidance = screen.getByLabelText('生成条件'), text = guidance.textContent;
  view.rerender(editor({ draft: empty, saving: true }));
  expect(screen.getByLabelText('生成条件')).toBe(guidance);
  expect(guidance.textContent).toBe(text);
  fireEvent.click(within(guidance).getByRole('button', { name: '去填写' }));
  expect(document.activeElement).toBe(screen.getByLabelText('剧情描述'));
  act(() => vi.advanceTimersByTime(900));
  expect(guidance.textContent).toBe(text);
  expect(generate()).toBeDisabled(); expect(submit).not.toHaveBeenCalled();
});

it('reports failures immediately, preserves the prompt and retains explicit retry actions', () => {
  const view = render(editor({ saving: true }));
  view.rerender(editor({ error: Error('STORAGE_OPERATION_FAILED') }));
  expect(status()).toHaveTextContent('草稿未保存');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByLabelText('生成条件')).toHaveTextContent('草稿尚未保存成功');
  expect(screen.getByLabelText('剧情描述')).toHaveValue(draft.prompt);
  expect(generate()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重试保存' }));
  expect(retry).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
});

it('cancels stale save notices and gives each new save its own delay', () => {
  const view = render(editor({ saving: true }));
  act(() => vi.advanceTimersByTime(700));
  view.rerender(editor());
  act(() => vi.advanceTimersByTime(50));
  view.rerender(editor({ saving: true }));
  act(() => vi.advanceTimersByTime(100));
  expect(status()).toHaveTextContent('草稿自动保存');
  act(() => vi.advanceTimersByTime(700));
  expect(status()).toHaveTextContent('正在保存草稿…');
  view.rerender(editor());
  act(() => vi.advanceTimersByTime(1000));
  expect(status()).toHaveTextContent('草稿自动保存');
  view.rerender(editor({ saving: true }));
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
