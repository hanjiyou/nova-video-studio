import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchShell } from '../WorkbenchShell';
import { DEFAULT_GROUP_ID, DRAFT_MODES, type DraftMode, type WorkspacePreferences } from '@/lib/workbench-client';
import { resetTaskStateForTests } from '@/lib/workbench-task-state';
import { novaTaskSocket } from '@/lib/ccode-task-socket';
import { setUpdateFrozen } from '@/lib/update-readiness';
const commit = '7fa4b7903e7ebecf832a36249f0c0c755200cc17';
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { resetTaskStateForTests(); novaTaskSocket.disable(); setUpdateFrozen(false); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); delete window.novaDesktop; vi.restoreAllMocks(); vi.unstubAllGlobals(); setUpdateFrozen(false); });
function fixture(initial: WorkspacePreferences = { activePage: 'editor', activeMode: 'video.dual_reference', returnPage: 'editor' }, dismissed = true) {
  let workspace = { key: 'workspace', value: initial, revision: 0, updatedAt: null as string | null };
  let draftGate: ReturnType<typeof deferred<void>> | null = null;
  const drafts = new Map(DRAFT_MODES.map(mode => [mode, { mode, prompt: '', model: '', parameters: {}, inputAssets: [], revision: 0, updatedAt: null }]));
  const requests: Array<{ url: string; method: string }> = [];
  const hide = vi.fn(async () => ({ ok: true }));
  Object.defineProperty(window, 'novaDesktop', { configurable: true, value: {
    getOutputDirectory: vi.fn(async () => ({ ok: true, displayName: '合成输出目录' })),
    getEditorState: vi.fn(async () => ({ ok: true, state: { phase: 'ready', available: true, engineCommit: commit } })),
    openEditor: vi.fn(async () => ({ ok: true, state: { phase: 'ready', available: true, engineCommit: commit } })),
    setEditorViewport: vi.fn(async () => ({ ok: true })), hideEditor: hide, onEditorState: () => () => {},
  } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method || 'GET', body = options?.body ? JSON.parse(String(options.body)) : undefined; requests.push({ url, method });
    if (url === '/api/nova/connections/current') return Response.json({ connection: null });
    if (url === '/api/nova/storage/settings/workspace') {
      if (method === 'PUT') { if (body.expectedRevision !== workspace.revision) return Response.json({ code: 'SETTING_REVISION_CONFLICT' }, { status: 409 }); workspace = { ...workspace, value: body.value, revision: workspace.revision + 1 }; }
      return Response.json({ setting: workspace });
    }
    if (url.startsWith('/api/nova/storage/settings/')) return Response.json({ setting: { key: url.split('/').pop(), value: url.endsWith('/onboarding') ? { dismissed, step: dismissed ? 'completed' : 'connection' } : null, revision: 0, updatedAt: null } });
    if (url.startsWith('/api/nova/storage/drafts/')) {
      const mode = url.split('/').pop() as DraftMode;
      if (method === 'PUT') { if (draftGate) { const gate = draftGate; draftGate = null; await gate.promise; } drafts.set(mode, { ...drafts.get(mode)!, ...body, revision: drafts.get(mode)!.revision + 1 }); }
      return Response.json({ draft: drafts.get(mode) });
    }
    if (url === '/api/nova/storage/groups') return Response.json({ items: [{ groupId: DEFAULT_GROUP_ID, name: '未分组', isDefault: true, createdAt: '', outputLocation: '' }], defaultGroupId: DEFAULT_GROUP_ID });
    if (url.startsWith('/api/nova/storage/tasks?') || url === '/api/nova/storage/submissions') return Response.json({ items: [], total: 0 });
    throw Error('Unexpected local request: ' + url);
  }));
  return { requests, workspace: () => workspace.value, drafts, hide, deferDraft: () => { const gate = deferred<void>(); draftGate = gate; return gate; } };
}
it('restores video editing without a generation connection, keeps five destinations and no generation panel', async () => {
  const data = fixture(undefined, false); render(<WorkbenchShell />);
  await screen.findByRole('region', { name: 'OpenChatCut 原版剪辑工作区' });
  expect(within(screen.getByRole('navigation', { name: '主要导航' })).getAllByRole('button').map(button => button.textContent)).toEqual(['图片生成', '视频生成', '视频剪辑', '作品库', '设置']);
  expect(screen.getByRole('button', { name: '视频剪辑' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByLabelText('剧情描述')).not.toBeInTheDocument(); expect(screen.queryByRole('heading', { name: '最近视频任务' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /欢迎使用/ })).not.toBeInTheDocument();
  expect(data.requests.some(request => request.url.includes('/tasks?') || request.method === 'POST')).toBe(false);
});
it('the local editing entry can bypass first-run generation setup without marking setup complete', async () => {
  const data = fixture({ activePage: 'image' }, false); render(<WorkbenchShell />);
  fireEvent.click(await screen.findByRole('button', { name: '先使用本地视频剪辑' }));
  await screen.findByRole('region', { name: 'OpenChatCut 原版剪辑工作区' });
  await waitFor(() => expect(data.workspace().activePage).toBe('editor'));
  expect(data.requests.some(request => request.url.endsWith('/onboarding') && request.method === 'PUT')).toBe(false);
  expect(data.requests.some(request => request.method === 'POST')).toBe(false);
});
it('settings returns to editing and persisted settings restore the editing return target on restart', async () => {
  const data = fixture(), view = render(<WorkbenchShell />); await screen.findByRole('region');
  fireEvent.click(screen.getByRole('button', { name: '设置' })); await screen.findByRole('button', { name: '返回创作' });
  await waitFor(() => expect(data.workspace()).toMatchObject({ activePage: 'settings', returnPage: 'editor', activeMode: 'video.dual_reference' }));
  expect(data.hide).toHaveBeenCalled(); view.unmount(); render(<WorkbenchShell />);
  fireEvent.click(await screen.findByRole('button', { name: '返回创作' }));
  await screen.findByRole('region', { name: 'OpenChatCut 原版剪辑工作区' });
  await waitFor(() => expect(data.workspace().activePage).toBe('editor'));
});
it('entering editing waits for an in-flight draft save and preserves prompt/mode without generation', async () => {
  const data = fixture({ activePage: 'image', activeMode: 'image.text' }); render(<WorkbenchShell />);
  const input = await screen.findByLabelText('画面描述'), gate = data.deferDraft();
  fireEvent.change(input, { target: { value: '进入剪辑之前的图片草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '视频剪辑' }));
  expect(screen.queryByRole('region', { name: 'OpenChatCut 原版剪辑工作区' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '图片生成' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '图片生成' }));
  await act(async () => gate.resolve()); await screen.findByRole('region', { name: 'OpenChatCut 原版剪辑工作区' });
  expect(data.drafts.get('image.text')!.prompt).toBe('进入剪辑之前的图片草稿');
  await waitFor(() => expect(data.workspace()).toMatchObject({ activePage: 'editor', activeMode: 'image.text' }));
  expect(data.requests.every(request => ['GET', 'PUT'].includes(request.method))).toBe(true);
});
it('a failed draft save keeps the current page and input when entering editing', async () => {
  const data = fixture({ activePage: 'image', activeMode: 'image.text' }); render(<WorkbenchShell />);
  const input = await screen.findByLabelText('画面描述'), gate = data.deferDraft();
  fireEvent.change(input, { target: { value: '不能丢失的草稿' } }); fireEvent.click(screen.getByRole('button', { name: '视频剪辑' }));
  await act(async () => gate.reject(Error('synthetic write failure')));
  expect(await screen.findByText(/草稿未能保存，已保留当前页面与输入/)).toBeInTheDocument();
  expect(input).toHaveValue('不能丢失的草稿'); expect(screen.queryByRole('region', { name: 'OpenChatCut 原版剪辑工作区' })).not.toBeInTheDocument();
});
