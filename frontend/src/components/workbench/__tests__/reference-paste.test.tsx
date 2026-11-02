import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DraftEditor } from '../DraftEditor';
import { useWorkbenchDrafts } from '@/hooks/useWorkbenchDrafts';
import { DRAFT_MODES, type Draft } from '@/lib/workbench-client';
import type { AssetSummary } from '@/lib/workbench-task-client';
import { MAX_VIDEO_REFERENCE_ASSETS } from '@/lib/reference-policy';

const original: Draft = { mode: 'video.single_reference', model: 'grok-imagine-video-1.5-6s', prompt: '保留剧情描述', parameters: { seconds: 6 }, inputAssets: [], revision: 0, updatedAt: null };
const asset = (name: string): AssetSummary => ({ assetId: name, displayName: name, kind: 'image', mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', byteLength: 8, sha256: 'synthetic', availability: 'available', validationState: 'verified', previewUrl: '/api/nova/assets/' + name + '/content', width: 2, height: 2 });
const png = () => new File([new Uint8Array([137, 80, 78, 71])], '截图.png', { type: 'image/png' });
const changed = vi.fn(), submit = vi.fn(), busy = vi.fn(), picker = vi.fn();

function Harness({ initial = original, disabled = false }: { initial?: Draft; disabled?: boolean }) {
  const [draft, setDraft] = useState(initial);
  return <fieldset disabled={disabled}><DraftEditor draft={draft} connection={null} models={null} saving={false} onChange={patch => { changed(patch); setDraft(previous => ({ ...previous, ...patch })); }} onConfigure={vi.fn()} onRetry={vi.fn()} onReload={vi.fn()} onSubmit={submit} onImportBusyChange={busy} /></fieldset>;
}
function clipboard(files: File[], itemsOnly = false) {
  return { files: itemsOnly ? [] : files, items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })), getData: () => '' };
}
function acceptImports() {
  const fetcher = vi.fn(async (route: unknown, init?: RequestInit) => {
    expect(route).toBe('/api/nova/assets/import');
    expect(init?.method).toBe('POST');
    const file = init?.body as File;
    return Response.json({ asset: asset(file.name) }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => {
  changed.mockReset(); submit.mockReset(); busy.mockReset(); picker.mockReset();
  vi.stubGlobal('fetch', vi.fn());
  window.novaDesktop = { importReferenceAssets: picker } as unknown as Window['novaDesktop'];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.novaDesktop; });

it.each(['video.single_reference', 'video.dual_reference', 'image.text'] as const)('pastes original PNG bytes into %s through the local importer without generating or opening a picker', async mode => {
  const fetcher = acceptImports(), file = png();
  render(<Harness initial={{ ...original, mode }} />);
  const area = screen.getByLabelText('参考图片区域');
  expect(area).toHaveAttribute('tabindex', '0');
  expect(area).toHaveAccessibleDescription(/Ctrl\+V/);
  expect(fireEvent.paste(area, { clipboardData: clipboard([file]) })).toBe(false);
  await screen.findByAltText('参考图 1：截图.png');
  const options = fetcher.mock.calls[0][1]!;
  expect(options.body).toBe(file);
  expect(options.headers).toEqual({ 'content-type': 'image/png', 'x-nova-filename': encodeURIComponent(file.name) });
  expect(changed).toHaveBeenLastCalledWith({ inputAssets: [asset(file.name)] });
  expect(screen.getByLabelText(mode === 'image.text' ? '画面描述' : '剧情描述')).toHaveValue(original.prompt);
  expect(busy.mock.calls.map(call => call[0])).toEqual([true, false]);
  expect(picker).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});

it('accepts image items from a screenshot clipboard while the prompt has focus', async () => {
  const fetcher = acceptImports(), file = png();
  render(<Harness />);
  const prompt = screen.getByLabelText('剧情描述'); prompt.focus();
  expect(fireEvent.paste(prompt, { clipboardData: clipboard([file], true) })).toBe(false);
  await screen.findByAltText('参考图 1：截图.png');
  expect(fetcher).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
});

it('appends multiple copied PNG/JPEG files in clipboard order and retains existing references', async () => {
  const fetcher = acceptImports(), first = png(), second = new File(['jpeg-original'], '第二张.jpg', { type: 'image/jpeg' }), existing = asset('已有.png');
  render(<Harness initial={{ ...original, mode: 'video.dual_reference', inputAssets: [existing] }} />);
  fireEvent.paste(screen.getByLabelText('参考图片区域'), { clipboardData: clipboard([first, second]) });
  await screen.findByAltText('参考图 3：第二张.jpg');
  expect(fetcher.mock.calls.map(call => call[1]?.body)).toEqual([first, second]);
  expect(changed).toHaveBeenLastCalledWith({ inputAssets: [existing, asset(first.name), asset(second.name)] });
});

it.each([
  ['video.single_reference', 1], ['video.dual_reference', MAX_VIDEO_REFERENCE_ASSETS],
] as const)('rejects overflow in %s before uploading and leaves the current references intact', async (mode, limit) => {
  const existing = Array.from({ length: limit }, (_, index) => asset('已有-' + index + '.png'));
  render(<Harness initial={{ ...original, mode, inputAssets: existing }} />);
  fireEvent.paste(screen.getByLabelText('剧情描述'), { clipboardData: clipboard([png()]) });
  expect(await screen.findByRole('alert')).toHaveTextContent(`最多使用 ${limit} 张参考图`);
  expect(fetch).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  expect(screen.getAllByAltText(/^参考图/)).toHaveLength(limit);
});

it('rejects a whole pasted batch that would exceed the remaining space', async () => {
  const existing = Array.from({ length: MAX_VIDEO_REFERENCE_ASSETS - 1 }, (_, index) => asset(index + '.png'));
  render(<Harness initial={{ ...original, mode: 'video.dual_reference', inputAssets: existing }} />);
  fireEvent.paste(screen.getByLabelText('参考图片区域'), { clipboardData: clipboard([png(), new File(['second'], 'second.jpg', { type: 'image/jpeg' })]) });
  expect(await screen.findByRole('alert')).toHaveTextContent('未导入或移除任何图片');
  expect(fetch).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it('does not intercept ordinary text, copied URLs, or non-image files', () => {
  render(<Harness />);
  const prompt = screen.getByLabelText('剧情描述');
  for (const text of ['粘贴中文剧情', 'https://example.invalid/image.png']) {
    expect(fireEvent.paste(prompt, { clipboardData: { files: [], items: [{ kind: 'string', type: 'text/plain' }], getData: () => text } })).toBe(true);
  }
  expect(fireEvent.paste(prompt, { clipboardData: clipboard([new File(['pdf'], '说明.pdf', { type: 'application/pdf' })]) })).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it('does not import reference images in text-video mode, including a legacy draft with references', () => {
  const view = render(<Harness initial={{ ...original, mode: 'video.text' }} />);
  expect(fireEvent.paste(screen.getByLabelText('剧情描述'), { clipboardData: clipboard([png()]) })).toBe(true);
  view.unmount();
  render(<Harness initial={{ ...original, mode: 'video.text', inputAssets: [asset('legacy.png')] }} />);
  expect(fireEvent.paste(screen.getByLabelText('参考图片区域'), { clipboardData: clipboard([png()]) })).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it('ignores pastes while switching drafts disables the surrounding fieldset', () => {
  render(<Harness disabled />);
  expect(fireEvent.paste(screen.getByLabelText('参考图片区域'), { clipboardData: clipboard([png()]) })).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it('prevents concurrent paste imports and restores input after a failed local import', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  render(<Harness />);
  const prompt = screen.getByLabelText('剧情描述');
  fireEvent.paste(prompt, { clipboardData: clipboard([png()]) });
  fireEvent.paste(prompt, { clipboardData: clipboard([png()]) });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('生成条件')).toHaveTextContent('正在导入参考图');
  await act(async () => { finish(Response.json({ code: 'ASSET_SIZE_INVALID' }, { status: 400 })); });
  expect(await screen.findByRole('alert')).toHaveTextContent('100 MiB');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.paste(prompt, { clipboardData: clipboard([png()]) });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { finish(Response.json({ asset: asset('截图.png') }, { status: 201 })); });
  await screen.findByAltText('参考图 1：截图.png');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(submit).not.toHaveBeenCalled();
});

it('reports unsupported clipboard images without converting them or uploading a partial batch', async () => {
  render(<Harness initial={{ ...original, mode: 'video.dual_reference' }} />);
  fireEvent.paste(screen.getByLabelText('参考图片区域'), { clipboardData: clipboard([png(), new File(['webp'], 'image.webp', { type: 'image/webp' })]) });
  expect(await screen.findByRole('alert')).toHaveTextContent('参考图支持 PNG、JPEG');
  expect(fetch).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it('persists pasted references using the existing draft revision and asset IDs', async () => {
  const file = png(), savedAsset = asset(file.name), calls: Array<{ route: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (route: string, init?: RequestInit) => {
    calls.push({ route, init });
    if (route === '/api/nova/assets/import') return Response.json({ asset: savedAsset }, { status: 201 });
    const mode = DRAFT_MODES.find(value => route.endsWith('/' + value));
    if (!mode) throw Error('Unexpected request');
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      return Response.json({ draft: { ...original, ...body, mode, inputAssets: [savedAsset], revision: body.expectedRevision + 1, updatedAt: '2026-11-02T00:00:00Z' } });
    }
    return Response.json({ draft: { ...original, mode, revision: 4 } });
  }));
  function PersistentEditor() {
    const drafts = useWorkbenchDrafts();
    useEffect(() => { void drafts.load(); }, [drafts.load]);
    const draft = drafts.drafts['video.single_reference'];
    return draft ? <DraftEditor draft={draft} connection={null} models={null} saving={Boolean(drafts.saving[draft.mode])} onChange={patch => drafts.update(draft.mode, patch)} onConfigure={vi.fn()} onRetry={vi.fn()} onReload={vi.fn()} onSubmit={submit} /> : null;
  }
  render(<PersistentEditor />);
  fireEvent.paste(await screen.findByLabelText('参考图片区域'), { clipboardData: clipboard([file]) });
  await waitFor(() => expect(calls.filter(call => call.init?.method === 'PUT')).toHaveLength(1));
  const put = calls.find(call => call.init?.method === 'PUT')!;
  expect(put.route).toBe('/api/nova/storage/drafts/video.single_reference');
  expect(JSON.parse(String(put.init?.body))).toEqual({ prompt: original.prompt, model: original.model, parameters: original.parameters, expectedRevision: 4, inputAssets: [{ assetId: savedAsset.assetId, role: 'reference', position: 0 }] });
  await waitFor(() => expect(screen.getByLabelText('草稿保存状态')).toHaveAttribute('aria-busy', 'false'));
  expect(submit).not.toHaveBeenCalled();
});
