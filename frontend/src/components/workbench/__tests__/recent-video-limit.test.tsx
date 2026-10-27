import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchShell } from '../WorkbenchShell';
import { RecentVideoTaskSettings } from '../RecentVideoTaskSettings';
import { useWorkbenchTasks } from '@/hooks/useWorkbenchTasks';
import { hasUpdateBlockers, setUpdateFrozen } from '@/lib/update-readiness';
import { resetTaskStateForTests } from '@/lib/workbench-task-state';
import { novaTaskSocket } from '@/lib/ccode-task-socket';
import { DRAFT_MODES, type HistoryTask, type WorkspacePreferences } from '@/lib/workbench-client';
const created = '2026-10-27T00:00:00.000Z';
function row(index: number, kind: 'image' | 'video' = 'video'): HistoryTask {
  const active = kind === 'video';
  return { id: kind + index, localTaskId: kind + index, mode: kind + '.text', prompt: (active ? '视频' : '图片') + index, model: 'synthetic', status: active ? index % 2 ? 'local_queued' : 'generating' : 'completed', localExecutionActive: active, createdAt: created, completedAt: active ? null : created, expiresAt: null, parameters: {}, outputAssets: [] };
}
const videos = Array.from({ length: 25 }, (_, index) => row(index)), images = Array.from({ length: 20 }, (_, index) => row(index, 'image'));
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { resetTaskStateForTests(); novaTaskSocket.disable(); setUpdateFrozen(false); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setUpdateFrozen(false); delete window.novaDesktop; });
function shellFixture(initial: WorkspacePreferences = { activeMode: 'video.text', activePage: 'video', returnPage: 'video', wideMode: true }) {
  let saved = { key: 'workspace', value: initial, revision: 4, updatedAt: null as string | null };
  const calls: Array<{ url: string; method: string; body?: { value: WorkspacePreferences; expectedRevision: number } }> = [];
  let firstWrite: ReturnType<typeof deferred<void>> | null = null;
  const draftRecords = new Map(DRAFT_MODES.map(mode => [mode, { mode, prompt: '', model: '', parameters: {}, inputAssets: [], revision: 0, updatedAt: null }]));
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined; calls.push({ url, method: options?.method || 'GET', body });
    if (url === '/api/nova/connections/current') return Response.json({ connection: null });
    if (url === '/api/nova/storage/settings/workspace') {
      if (options?.method === 'PUT') {
        if (firstWrite) { const pending = firstWrite; firstWrite = null; await pending.promise; }
        if (body.expectedRevision !== saved.revision) return Response.json({ code: 'SETTING_REVISION_CONFLICT' }, { status: 409 });
        saved = { ...saved, value: body.value, revision: saved.revision + 1 };
      }
      return Response.json({ setting: saved });
    }
    if (url.startsWith('/api/nova/storage/settings/')) return Response.json({ setting: { key: url.split('/').pop(), value: url.endsWith('/onboarding') ? { dismissed: true, step: 'completed' } : null, revision: 0, updatedAt: null } });
    if (url.startsWith('/api/nova/storage/drafts/')) return Response.json({ draft: draftRecords.get(url.split('/').pop() as typeof DRAFT_MODES[number]) });
    if (url.startsWith('/api/nova/storage/tasks?')) { const query = new URL(url, 'http://synthetic.invalid').searchParams; const items = query.get('kind') === 'video' ? videos : images; return Response.json({ items: items.slice(0, Number(query.get('limit'))), total: items.length, unfilteredTotal: 45 }); }
    if (url === '/api/nova/storage/submissions') return Response.json({ items: [] });
    throw Error('Unexpected offline request: ' + url);
  }));
  return { calls, saved: () => saved, deferFirstWrite: () => { const pending = deferred<void>(); firstWrite = pending; return pending; } };
}
function SettingsHarness({ save = async () => {}, reload = async () => 20 }: { save?: (value: number) => Promise<void>; reload?: () => Promise<number> }) {
  const [value, setValue] = useState(6);
  return <RecentVideoTaskSettings value={value} onSave={async next => { await save(next); setValue(next); }} onReload={async () => { const next = await reload(); setValue(next); return next; }} />;
}

it('old workspace defaults to6, saves10 and20, preserves navigation, restores on remount and keeps images at6', async () => {
  const fixture = shellFixture(); const view = render(<WorkbenchShell />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^预览任务：视频/ })).toHaveLength(6));
  expect(screen.getByText(/当前显示：处理中 3 项 · 等待处理 3 项/)).toBeInTheDocument();
  for (const count of [10, 20]) {
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const panel = screen.getByRole('region', { name: '工作台显示' });
    expect(within(panel).getByLabelText('最近视频任务数量')).toHaveValue(count === 10 ? 6 : 10);
    fireEvent.change(within(panel).getByLabelText('最近视频任务数量'), { target: { value: String(count) } });
    fireEvent.click(within(panel).getByRole('button', { name: '保存显示设置' }));
    await waitFor(() => expect(within(panel).getByRole('status')).toHaveTextContent('显示设置已保存'));
    expect(fixture.saved().value).toMatchObject({ recentVideoTaskLimit: count, activeMode: 'video.text', activePage: 'settings', returnPage: 'video', wideMode: true });
    fireEvent.click(screen.getByRole('button', { name: '返回创作' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^预览任务：视频/ })).toHaveLength(count));
    expect(screen.getByText(`当前显示：处理中 ${count / 2} 项 · 等待处理 ${count / 2} 项。取消或超时后会为后续任务释放本地名额。`)).toBeInTheDocument();
  }
  await waitFor(() => expect(fixture.saved().value.activePage).toBe('video'));
  view.unmount(); render(<WorkbenchShell />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^预览任务：视频/ })).toHaveLength(20));
  fireEvent.click(screen.getByRole('button', { name: '图片生成' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^预览任务：图片/ })).toHaveLength(6));
  expect(fixture.calls.some(call => call.url.includes('kind=video') && call.url.includes('limit=20'))).toBe(true);
  expect(fixture.calls.some(call => call.url.includes('kind=image') && call.url.includes('limit=12'))).toBe(true);
  expect(fixture.calls.every(call => ['GET', 'PUT'].includes(call.method))).toBe(true);
  const writes = fixture.calls.filter(call => call.method === 'PUT');
  expect(writes.map(call => call.body?.expectedRevision)).toEqual(writes.map((_, index) => index + 4));
});

it('display save and navigation serialize against one workspace revision and retain each other fields', async () => {
  const fixture = shellFixture(); render(<WorkbenchShell />);
  await screen.findByRole('button', { name: '预览任务：视频0' });
  const first = fixture.deferFirstWrite(); fireEvent.click(screen.getByRole('button', { name: '设置' }));
  await waitFor(() => expect(fixture.calls.filter(call => call.method === 'PUT')).toHaveLength(1));
  fireEvent.change(screen.getByLabelText('最近视频任务数量'), { target: { value: '20' } });
  fireEvent.click(screen.getByRole('button', { name: '保存显示设置' }));
  fireEvent.click(screen.getByRole('button', { name: '图片生成' }));
  expect(fixture.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  await act(async () => first.resolve());
  await waitFor(() => expect(fixture.saved().value).toMatchObject({ activePage: 'image', activeMode: 'image.text', returnPage: 'video', wideMode: true, recentVideoTaskLimit: 20 }));
  expect(fixture.calls.filter(call => call.method === 'PUT').map(call => call.body?.expectedRevision)).toEqual([4, 5, 6]);
  expect(screen.queryByText(/设置已更新/)).not.toBeInTheDocument();
});

it.each(['', '0', '101', '1.5', 'abc'])('invalid input %j is readable and cannot save', input => {
  const save = vi.fn(); render(<SettingsHarness save={save} />);
  fireEvent.change(screen.getByLabelText('最近视频任务数量'), { target: { value: input } });
  expect(screen.getByText('请填写 1–100 的整数，不能为空。')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存显示设置' })).toBeDisabled(); expect(save).not.toHaveBeenCalled(); expect(hasUpdateBlockers()).toBe(true);
});

it('dirty and pending display values block updates; failed save retains input without success and retry can succeed once', async () => {
  const pending = deferred<void>(), save = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined);
  render(<SettingsHarness save={save} />); expect(hasUpdateBlockers()).toBe(false);
  fireEvent.change(screen.getByLabelText('最近视频任务数量'), { target: { value: '10' } }); expect(hasUpdateBlockers()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '保存显示设置' })); fireEvent.click(screen.getByRole('button', { name: '正在读取或保存…' }));
  expect(save).toHaveBeenCalledTimes(1); expect(hasUpdateBlockers()).toBe(true);
  await act(async () => pending.reject(Error('STORAGE_OPERATION_FAILED')));
  expect(screen.getByRole('alert')).toHaveTextContent('已有记录和文件仍保留'); expect(screen.getByLabelText('最近视频任务数量')).toHaveValue(10); expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存显示设置' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('显示设置已保存')); expect(hasUpdateBlockers()).toBe(false); expect(save).toHaveBeenCalledTimes(2);
});

it('revision conflict preserves input until explicit reload and frozen updates do not save', async () => {
  const save = vi.fn(async () => { throw Error('SETTING_REVISION_CONFLICT'); }), reload = vi.fn(async () => 20);
  render(<SettingsHarness save={save} reload={reload} />);
  fireEvent.change(screen.getByLabelText('最近视频任务数量'), { target: { value: '10' } }); fireEvent.click(screen.getByRole('button', { name: '保存显示设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('输入已保留'); expect(screen.getByLabelText('最近视频任务数量')).toHaveValue(10); expect(screen.getByRole('button', { name: '保存显示设置' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重新读取显示设置' })); await waitFor(() => expect(screen.getByLabelText('最近视频任务数量')).toHaveValue(20)); expect(hasUpdateBlockers()).toBe(false);
  setUpdateFrozen(true); fireEvent.change(screen.getByLabelText('最近视频任务数量'), { target: { value: '30' } }); fireEvent.click(screen.getByRole('button', { name: '保存显示设置' })); expect(save).toHaveBeenCalledTimes(1);
});

it.each(['image', 'video'] as const)('late %s history is discarded and immediately followed by the configured20 request', async firstKind => {
  const first = deferred<Response>(), latest = deferred<Response>(), limits: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/submissions')) return Response.json({ items: [] });
    limits.push(Number(new URL(url, 'http://synthetic.invalid').searchParams.get('limit')));
    return limits.length === 1 ? first.promise : latest.promise;
  }));
  const hook = renderHook(({ kind, limit }: { kind: 'image' | 'video'; limit: number }) => useWorkbenchTasks(true, kind, null, null, undefined, limit), { initialProps: { kind: firstKind as 'image' | 'video', limit: 6 } });
  await waitFor(() => expect(limits).toEqual([firstKind === 'image' ? 12 : 6]));
  hook.rerender({ kind: 'video', limit: 20 });
  await act(async () => first.resolve(Response.json({ items: (firstKind === 'image' ? images : videos).slice(0, limits[0]), total: 25 })));
  await waitFor(() => expect(limits).toEqual([firstKind === 'image' ? 12 : 6, 20]));
  expect(hook.result.current.history).toBeNull();
  await act(async () => latest.resolve(Response.json({ items: videos.slice(0, 20), total: 25 })));
  await waitFor(() => expect(hook.result.current.history?.items).toHaveLength(20)); expect(hook.result.current.error).toBe('');
});

it('shrinking recent count keeps a selected older task and refreshes it through the existing detail path', async () => {
  const detailReads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/submissions')) return Response.json({ items: [] });
    if (url.includes('/tasks?')) { const limit = Number(new URL(url, 'http://synthetic.invalid').searchParams.get('limit')); return Response.json({ items: videos.slice(0, limit), total: 25 }); }
    detailReads.push(url); return Response.json({ task: { ...videos[19], revision: 2 } });
  }));
  const hook = renderHook(({ limit }) => useWorkbenchTasks(true, 'video', null, null, undefined, limit), { initialProps: { limit: 20 } });
  await waitFor(() => expect(hook.result.current.history?.items).toHaveLength(20)); act(() => hook.result.current.select(videos[19]));
  hook.rerender({ limit: 6 });
  await waitFor(() => expect(hook.result.current.history?.items).toHaveLength(6));
  await waitFor(() => expect(hook.result.current.selected?.localTaskId).toBe('video19'));
  expect(detailReads).toContain('/api/nova/storage/tasks/video19'); expect(hook.result.current.selected?.revision).toBe(2);
});
