import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchLibrary } from '../WorkbenchLibrary';
import { WorkbenchLibraryPreview } from '../WorkbenchLibraryPreview';
import { resetTaskStateForTests } from '@/lib/workbench-task-state';
import type { HistoryTask } from '@/lib/workbench-client';
import type { AssetSummary } from '@/lib/workbench-task-client';

const image = (id: string): AssetSummary => ({ assetId: id, displayName: id + '.png', kind: 'image', mimeType: 'image/png', byteLength: 50, sha256: 'synthetic', width: 1600, height: 900, availability: 'available', validationState: 'verified', previewUrl: '/api/nova/assets/' + id + '/content' });
const video: AssetSummary = { ...image('old-video'), displayName: 'old-video.mp4', kind: 'video', mimeType: 'video/mp4', durationSeconds: 6 };
const task = (id: string, asset?: AssetSummary): HistoryTask => ({ id, localTaskId: id, status: 'completed', mode: asset?.kind === 'video' ? 'video.text' : 'image.text', createdAt: '2026-10-20T00:00:00.000Z', completedAt: '2026-10-20T00:01:00.000Z', expiresAt: null, prompt: id, model: 'synthetic-model', parameters: {}, outputAssets: asset ? [asset] : [] });
const callbacks = () => ({ onDetails: vi.fn(), onVideo: vi.fn(), onImage: vi.fn() });
function history(items: HistoryTask[]) {
  const requests: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method || 'GET' });
    if (init?.method === 'DELETE') return Response.json({ removed: true, deletedAssets: 0, retainedAssets: 1 });
    const query = new URL(url, 'http://synthetic.invalid').searchParams;
    const filtered = query.get('kind') === 'video' ? items.filter(item => item.mode.startsWith('video')) : items;
    const offset = Number(query.get('offset'));
    return Response.json({ items: filtered.slice(offset, offset + 24), total: filtered.length, unfilteredTotal: items.length });
  }));
  return requests;
}
beforeEach(() => {
  resetTaskStateForTests();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  Object.defineProperty(window, 'novaDesktop', { configurable: true, value: { saveAssetCopy: vi.fn(async () => ({ ok: true })), revealAsset: vi.fn(async () => ({ ok: true })) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.novaDesktop; });

it('single click does nothing, double click previews only the first image, and details remain independent', async () => {
  const first = image('first'), value = { ...task('图片作品', first), outputAssets: [first, image('second')] }, props = callbacks(), requests = history([value]);
  render(<WorkbenchLibrary revision={0} {...props} />);
  const card = await screen.findByRole('button', { name: '预览作品：图片作品' });
  fireEvent.click(card);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(props.onDetails).not.toHaveBeenCalled();
  fireEvent.doubleClick(card);
  const dialog = screen.getByRole('dialog', { name: '图片预览' });
  expect(within(dialog).getByRole('img')).toHaveAttribute('src', first.previewUrl);
  expect(within(dialog).queryByRole('video')).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: '另存副本' }));
  await waitFor(() => expect(window.novaDesktop?.saveAssetCopy).toHaveBeenCalledWith('first'));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '打开结果目录' })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole('button', { name: '打开结果目录' }));
  await waitFor(() => expect(window.novaDesktop?.revealAsset).toHaveBeenCalledWith('first'));
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }));
  expect(props.onDetails).toHaveBeenCalledWith(value); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(requests.every(request => request.method === 'GET' && request.url.startsWith('/api/nova/storage/tasks?'))).toBe(true);
});

it('selection and record removal do not open a preview or task details and preserve the existing deletion body', async () => {
  const value = task('独立操作', image('selected')), props = callbacks(), requests = history([value]);
  render(<WorkbenchLibrary revision={0} {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '选择图片' }));
  expect(screen.getByRole('list', { name: '已选图片顺序' })).toHaveTextContent('selected.png');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('更多作品操作')); fireEvent.click(screen.getByRole('button', { name: '从作品库隐藏' }));
  expect(screen.getByRole('dialog', { name: '移除作品记录' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: '图片预览' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '确认移除记录' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const deletion = vi.mocked(fetch).mock.calls.find(call => call[1]?.method === 'DELETE');
  expect(deletion?.[1]?.body).toBe(JSON.stringify({ deleteOutputs: false }));
  expect(props.onDetails).not.toHaveBeenCalled(); expect(props.onVideo).not.toHaveBeenCalled();
  expect(requests.filter(request => request.method !== 'GET')).toEqual([{ url: '/api/nova/storage/tasks/' + encodeURIComponent('独立操作'), method: 'DELETE' }]);
});

it('a page 2 old video uses native controls and closing preserves filters, page and ordered image selection', async () => {
  const images = [image('ordered-a'), image('ordered-b')], videos = Array.from({ length: 25 }, (_, index) => task('旧视频 ' + index, { ...video, assetId: 'video-' + index, previewUrl: '/api/nova/assets/video-' + index + '/content' }));
  const props = callbacks(), requests = history([task('图片 A', images[0]), task('图片 B', images[1]), ...videos]);
  render(<WorkbenchLibrary revision={0} {...props} />);
  await screen.findByText('图片 A');
  fireEvent.click(screen.getAllByRole('button', { name: '选择图片' })[0]);
  fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
  fireEvent.change(screen.getByLabelText('作品类型'), { target: { value: 'video' } });
  expect(screen.queryByLabelText('任务状态')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('搜索提示词或模型'), { target: { value: '旧视频' } });
  await waitFor(() => expect(screen.getByText('第 1 / 2 页 · 25 条')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  const card = await screen.findByRole('button', { name: '预览作品：旧视频 24' });
  fireEvent.doubleClick(card);
  const dialog = screen.getByRole('dialog', { name: '视频预览' }), player = within(dialog).getByLabelText('作品库视频预览');
  expect(player).toHaveAttribute('src', '/api/nova/assets/video-24/content');
  expect(player).toHaveAttribute('controls'); expect(player).not.toHaveAttribute('autoplay');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByLabelText('作品类型')).toHaveValue('video'); expect(screen.queryByLabelText('任务状态')).not.toBeInTheDocument(); expect(screen.getByLabelText('搜索提示词或模型')).toHaveValue('旧视频');
  expect(screen.getByText('第 2 / 2 页 · 25 条')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '带入多图参考草稿' }));
  expect(props.onVideo).toHaveBeenCalledWith(images);
  expect(requests.every(request => request.method === 'GET' && new URL(request.url, 'http://synthetic.invalid').searchParams.get('scope') === 'library')).toBe(true);
});

it.each(['Enter', ' '])('focused card supports %j and Escape returns focus without opening details', async key => {
  const props = callbacks(); history([task('键盘作品', image('keyboard'))]);
  render(<WorkbenchLibrary revision={0} {...props} />);
  const card = await screen.findByRole('button', { name: '预览作品：键盘作品' }); card.focus();
  fireEvent.keyDown(card, { key });
  const dialog = screen.getByRole('dialog', { name: '图片预览' }); expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(card).toHaveFocus(); expect(props.onDetails).not.toHaveBeenCalled();
});

it.each(['close', 'escape', 'backdrop'])('%s stops video and releases its source on close', async method => {
  history([task('视频清理', video)]); render(<WorkbenchLibrary revision={0} {...callbacks()} />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: '预览作品：视频清理' }));
  const dialog = screen.getByRole('dialog', { name: '视频预览' }), player = within(dialog).getByLabelText('作品库视频预览') as HTMLVideoElement;
  if (method === 'close') fireEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  else if (method === 'escape') fireEvent.keyDown(player, { key: 'Escape' });
  else fireEvent.click(dialog.parentElement!);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(vi.mocked(player.pause).mock.contexts.filter(context => context === player)).toHaveLength(1); expect(player).not.toHaveAttribute('src'); expect(vi.mocked(player.load).mock.contexts.filter(context => context === player)).toHaveLength(1);
});

it.each([
  { name: 'no output', value: task('empty'), reason: '此记录没有可用的本机输出文件' },
  { name: 'generating', value: { ...task('generating'), status: 'generating' as const }, reason: '本机结果尚未保存完成' },
  { name: 'download failed', value: { ...task('download-failed'), status: 'download_failed' as const }, reason: '结果尚未保存到本机' },
  { name: 'missing', value: task('missing', { ...video, availability: 'missing' as const }), reason: '结果文件已被外部移除' },
  { name: 'corrupt', value: task('corrupt', { ...image('corrupt'), availability: 'corrupt' as const }), reason: '结果文件已损坏' },
  { name: 'no local preview URL', value: task('no-url', { ...video, previewUrl: '' }), reason: '此输出暂无可用的图片或视频预览' },
])('$name shows an explicit result state without a player or recovery request', ({ value, reason }) => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkbenchLibraryPreview task={value} onClose={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('暂无可预览结果'); expect(screen.getByRole('status')).toHaveTextContent(reason);
  expect(view.container.querySelector('video,img')).toBeNull(); expect(screen.getByRole('button', { name: '另存副本' })).toBeDisabled(); expect(fetcher).not.toHaveBeenCalled();
});

it('image load error stays explicit and leaves the original details entry available', async () => {
  const props = callbacks(), value = task('读取失败', image('image-error')), requests = history([value]);
  render(<WorkbenchLibrary revision={0} {...props} />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: '预览作品：读取失败' }));
  const dialog = screen.getByRole('dialog', { name: '图片预览' }); fireEvent.error(within(dialog).getByRole('img'));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('图片加载失败'); expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' })); fireEvent.click(screen.getByRole('button', { name: '任务详情' }));
  expect(props.onDetails).toHaveBeenCalledWith(value); expect(requests.every(request => request.method === 'GET')).toBe(true);
});

it('video playback error replaces the player with Chinese guidance and releases the failed source', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  render(<WorkbenchLibraryPreview task={task('解码失败', video)} onClose={vi.fn()} />);
  const player = screen.getByLabelText('作品库视频预览') as HTMLVideoElement; fireEvent.error(player);
  expect(screen.getByRole('alert')).toHaveTextContent('视频无法播放'); expect(screen.getByRole('alert')).toHaveTextContent('浏览器不支持该编码');
  expect(screen.queryByLabelText('作品库视频预览')).not.toBeInTheDocument(); expect(vi.mocked(player.pause).mock.contexts.filter(context => context === player)).toHaveLength(1); expect(player).not.toHaveAttribute('src'); expect(vi.mocked(player.load).mock.contexts.filter(context => context === player)).toHaveLength(1);
  expect(screen.getByRole('button', { name: '另存副本' })).toBeEnabled(); expect(fetcher).not.toHaveBeenCalled();
});

it('StrictMode remount restores the local video source and real unmount still releases it', () => {
  const view = render(<StrictMode><WorkbenchLibraryPreview task={task('严格模式', video)} onClose={vi.fn()} /></StrictMode>);
  const player = screen.getByLabelText('作品库视频预览') as HTMLVideoElement;
  expect(player).toHaveAttribute('src', video.previewUrl);
  expect(player).toHaveAttribute('controls');
  expect(vi.mocked(player.pause).mock.contexts.filter(context => context === player)).toHaveLength(1); expect(vi.mocked(player.load).mock.contexts.filter(context => context === player)).toHaveLength(1);
  view.unmount();
  expect(player).not.toHaveAttribute('src'); expect(player.pause).toHaveBeenCalledTimes(2); expect(player.load).toHaveBeenCalledTimes(2);
});
it('legacy plugin video without an output keeps its card hint and preview title consistent', async () => {
  history([{ ...task('旧插件视频'), mode: 'plugin', mediaKind: 'video' }]);
  render(<WorkbenchLibrary revision={0} {...callbacks()} />);
  const card = await screen.findByRole('button', { name: '预览作品：旧插件视频' });
  expect(card).toHaveTextContent('双击预览视频'); fireEvent.doubleClick(card);
  expect(screen.getByRole('dialog', { name: '视频预览' })).toHaveTextContent('暂无可预览结果');
});
