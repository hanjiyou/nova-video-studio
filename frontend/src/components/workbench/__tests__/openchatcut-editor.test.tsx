import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchEditor } from '../WorkbenchEditor';
import { editorViewport, readEditorState, type EditorState, type EditorResult, type EditorViewport } from '@/lib/openchatcut-client';
const commit = '7fa4b7903e7ebecf832a36249f0c0c755200cc17';
const idle: EditorState = { phase: 'idle', available: true, engineCommit: commit };
const ready: EditorState = { ...idle, phase: 'ready' };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let observers: Array<() => void>;
let rectangle: DOMRect;
beforeEach(() => {
  observers = []; rectangle = new DOMRect(230.4, 50.4, 1000.3, 700.9);
  vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rectangle);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 0));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id));
});
afterEach(() => { cleanup(); delete window.novaDesktop; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function host(initial: EditorState = idle) {
  let listener: ((state: EditorState) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const api = {
    getEditorState: vi.fn(async (): Promise<EditorResult> => ({ ok: true, state: initial })),
    openEditor: vi.fn(async (): Promise<EditorResult> => ({ ok: true, state: ready })),
    setEditorViewport: vi.fn(async (_viewport: EditorViewport) => ({ ok: true })), hideEditor: vi.fn(async () => ({ ok: true })),
    onEditorState: vi.fn((next: (state: EditorState) => void) => { listener = next; return unsubscribe; }),
  };
  Object.defineProperty(window, 'novaDesktop', { configurable: true, value: api });
  return { api, unsubscribe, emit: (state: EditorState) => { listener?.(state); } };
}
it('without the native editor bridge exposes a truthful desktop-only state and no embedded web frame', async () => {
  render(<WorkbenchEditor />);
  expect(await screen.findByText(/需要使用支持剪辑组件的 Nova 桌面版/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重新打开剪辑' })).not.toBeInTheDocument();
  expect(document.querySelector('iframe,webview')).toBeNull();
});
it('opens the native editor once and sends its visible CSS bounds; resize and scroll remeasure the region', async () => {
  const fixture = host(); render(<WorkbenchEditor />);
  await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(fixture.api.setEditorViewport).toHaveBeenCalledWith({ visible: true, x: 231, y: 51, width: 999, height: 700 }));
  expect(screen.getByRole('region', { name: 'OpenChatCut 原版剪辑工作区' })).toHaveAttribute('data-phase', 'ready');
  rectangle = new DOMRect(240, -10, 1400, 700);
  act(() => { observers.forEach(callback => callback()); fireEvent.scroll(window); });
  await waitFor(() => expect(fixture.api.setEditorViewport).toHaveBeenLastCalledWith({ visible: true, x: 240, y: 0, width: 1200, height: 690 }));
});
it('an unavailable component stays unavailable until explicit retry; repeated clicks cannot open twice', async () => {
  const fixture = host({ ...idle, phase: 'unavailable', available: false, code: 'EDITOR_RUNTIME_MISSING' });
  const pending = deferred<{ ok: true; state: EditorState }>(); fixture.api.openEditor.mockReturnValue(pending.promise);
  render(<WorkbenchEditor />);
  expect(await screen.findByText(/剪辑组件尚未准备完成/)).toBeInTheDocument(); expect(fixture.api.openEditor).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新打开剪辑' }));
  fireEvent.click(screen.getByRole('button', { name: '正在打开…' })); expect(fixture.api.openEditor).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ ok: true, state: ready }));
  await waitFor(() => expect(fixture.api.setEditorViewport.mock.calls.some(([value]) => value.visible)).toBe(true));
});
it('leaving during startup unsubscribes and hides; late startup completion never shows a stale viewport', async () => {
  const fixture = host(), pending = deferred<{ ok: true; state: EditorState }>(); fixture.api.openEditor.mockReturnValue(pending.promise);
  const view = render(<WorkbenchEditor />); await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledOnce());
  view.unmount(); expect(fixture.unsubscribe).toHaveBeenCalledOnce(); expect(fixture.api.hideEditor).toHaveBeenCalled();
  await act(async () => pending.resolve({ ok: true, state: ready }));
  expect(fixture.api.setEditorViewport.mock.calls.every(([value]) => !value.visible)).toBe(true);
});
it('a newer state event wins over a late state read', async () => {
  const fixture = host(), read = deferred<{ ok: true; state: EditorState }>(); fixture.api.getEditorState.mockReturnValue(read.promise);
  render(<WorkbenchEditor />); act(() => fixture.emit(ready));
  await act(async () => read.resolve({ ok: true, state: idle }));
  expect(fixture.api.openEditor).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('region')).toHaveAttribute('data-phase', 'ready');
});
it('update freeze hides the view and removes subscriptions; unfreeze restores an existing ready editor', async () => {
  const fixture = host(ready), view = render(<WorkbenchEditor />);
  await waitFor(() => expect(fixture.api.setEditorViewport.mock.calls.some(([value]) => value.visible)).toBe(true));
  view.rerender(<WorkbenchEditor frozen />); expect(fixture.unsubscribe).toHaveBeenCalledOnce(); expect(fixture.api.hideEditor).toHaveBeenCalled();
  const previousCalls = fixture.api.setEditorViewport.mock.calls.length;
  act(() => { fixture.emit(ready); observers.forEach(callback => callback()); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(fixture.api.setEditorViewport.mock.calls.length).toBe(previousCalls);
  view.rerender(<WorkbenchEditor />);
  await waitFor(() => expect(fixture.api.getEditorState).toHaveBeenCalledTimes(2)); await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledTimes(2));
});
it('a rejected viewport produces an error and withdraws the visible viewport', async () => {
  const fixture = host(ready); fixture.api.setEditorViewport.mockResolvedValueOnce({ ok: false }); render(<WorkbenchEditor />);
  await screen.findByRole('alert');
  await waitFor(() => expect(fixture.api.setEditorViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false })));
});
it('native transport state and geometry reject invalid inputs and never expose extra native fields', () => {
  expect(readEditorState({ ...ready, origin: 'http://secret.invalid', token: 'private' })).toEqual(ready);
  expect(readEditorState({ ...ready, phase: 'made_up' })).toBeNull();
  expect(readEditorState({ ...ready, engineCommit: 'http://secret.invalid' })).toBeNull();
  expect(readEditorState({ ...ready, code: '/private/path' })).toBeNull();
  expect(editorViewport({ left: NaN, top: 0, right: 600, bottom: 400 }, 1000, 700, true).visible).toBe(false);
  expect(editorViewport({ left: 1500, top: 10, right: 1800, bottom: 400 }, 1000, 700, true)).toEqual({ visible: false, x: 1000, y: 10, width: 0, height: 390 });
});

it('idle emitted by the state read starts the editor even when its promise resolves later', async () => {
  const fixture = host(), read = deferred<EditorResult>(); fixture.api.getEditorState.mockReturnValue(read.promise);
  render(<WorkbenchEditor />); act(() => fixture.emit(idle));
  await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledTimes(1));
  await act(async () => read.resolve({ ok: true, state: idle }));
  await waitFor(() => expect(fixture.api.setEditorViewport.mock.calls.some(([value]) => value.visible)).toBe(true));
  expect(fixture.api.openEditor).toHaveBeenCalledTimes(1);
});
it('returning to a visible document reactivates the existing native editor after hiding it', async () => {
  const fixture = host(ready), visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  render(<WorkbenchEditor />);
  await waitFor(() => expect(fixture.api.setEditorViewport.mock.calls.some(([value]) => value.visible)).toBe(true));
  visibility.mockReturnValue(true); act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(fixture.api.hideEditor).toHaveBeenCalled());
  visibility.mockReturnValue(false); act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(fixture.api.setEditorViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true })));
});
it('preserves an authoritative failure state and shows its actual missing-build reason', async () => {
  const fixture = host({ ...idle, phase: 'unavailable', available: false, code: 'EDITOR_DEPENDENCIES_MISSING' });
  fixture.api.openEditor.mockResolvedValue({ ok: false, code: 'EDITOR_BUILD_MISSING', state: { ...idle, phase: 'unavailable', available: false } });
  render(<WorkbenchEditor />); await screen.findByText(/运行依赖尚未安装/);
  fireEvent.click(screen.getByRole('button', { name: '重新打开剪辑' }));
  await screen.findByText('剪辑组件尚未构建，请先完成组件准备。');
  expect(screen.queryByText(/暂时无法打开剪辑工作区/)).not.toBeInTheDocument();
});

it('an authoritative ready event also wins over a late rejected state read', async () => {
  const fixture = host(), read = deferred<EditorResult>(); fixture.api.getEditorState.mockReturnValue(read.promise);
  render(<WorkbenchEditor />); act(() => fixture.emit(ready));
  await act(async () => read.reject(Error('late synthetic transport failure')));
  expect(screen.getByRole('region')).toHaveAttribute('data-phase', 'ready'); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('a hide/show cycle during startup requests a fresh activation after the old open settles', async () => {
  const fixture = host(), pending = deferred<EditorResult>(); fixture.api.openEditor.mockReturnValueOnce(pending.promise);
  const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  render(<WorkbenchEditor />); await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledTimes(1));
  visibility.mockReturnValue(true); act(() => document.dispatchEvent(new Event('visibilitychange')));
  visibility.mockReturnValue(false); act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => pending.resolve({ ok: false, code: 'EDITOR_STOPPED', state: { ...idle, phase: 'stopped' } }));
  await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(fixture.api.setEditorViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true })));
});

it('mounting an already-ready editor after navigation reactivates it instead of only sending bounds', async () => {
  const fixture = host(ready), first = render(<WorkbenchEditor />);
  await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledTimes(1));
  first.unmount(); expect(fixture.api.hideEditor).toHaveBeenCalled();
  render(<WorkbenchEditor />);
  await waitFor(() => expect(fixture.api.openEditor).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(fixture.api.setEditorViewport).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true })));
});
