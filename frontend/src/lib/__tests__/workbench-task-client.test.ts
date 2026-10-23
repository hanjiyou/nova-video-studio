import { afterEach, expect, it, vi } from 'vitest';
import { desktopTaskPayload } from '@/lib/connection-client';
import { actOnWorkbenchTask, createWorkbenchTask, getWorkbenchTask, WorkbenchTaskActionError } from '@/lib/workbench-task-client';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('keeps local intent and immutable connection across concurrent sends and a lost ACK', async () => {
  const connection = { connectionVersionId: 'version-A', hasCredential: true, credentialState: 'ready' };
  const fetcher = vi.fn(async () => Response.json({ connection })); vi.stubGlobal('fetch', fetcher);
  const input = { model: 'exact-model', prompt: '中文\n"台词"', apiKey: 'never-http' };
  const [first, second] = await Promise.all([desktopTaskPayload(input), desktopTaskPayload(input)]);
  expect(first).toEqual(second); expect(first).toMatchObject({ connectionVersionId: 'version-A', localRequestId: expect.any(String) }); expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(Response.json({ connection: { ...connection, connectionVersionId: 'version-B' } }));
  expect(await desktopTaskPayload(input)).toEqual(first); expect(fetcher).toHaveBeenCalledTimes(1); expect(JSON.stringify(first)).not.toContain('never-http');
});
it('new intents get distinct IDs and explicit caller IDs remain intact', async () => {
  const a = await desktopTaskPayload({ connectionVersionId: 'version-A', prompt: 'same' });
  const b = await desktopTaskPayload({ connectionVersionId: 'version-A', prompt: 'same' });
  expect((a as Record<string, unknown>).localRequestId).not.toBe((b as Record<string, unknown>).localRequestId);
  expect(await desktopTaskPayload({ localRequestId: 'explicit-local-id', connectionVersionId: 'version-A' })).toEqual({ localRequestId: 'explicit-local-id', connectionVersionId: 'version-A' });
});
it('never retries a failed action POST', async () => {
  const fetcher = vi.fn(async () => { throw new TypeError('lost local ACK'); }); vi.stubGlobal('fetch', fetcher);
  await expect(actOnWorkbenchTask('local/A', 'resume-polling')).rejects.toThrow('lost local ACK'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retains notBeforeAt and the exact resume error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'POLL_NOT_BEFORE', error: '尚未到允许时间', notBeforeAt: '2026-10-23T01:00:00Z' }, { status: 409 })));
  await expect(actOnWorkbenchTask('local-id', 'resume-polling')).rejects.toMatchObject({ code: 'POLL_NOT_BEFORE', statusCode: 409, notBeforeAt: '2026-10-23T01:00:00Z' });
});
it('retains conservative reservation notices and encodes the local task ID', async () => {
  const task = { id: 'local/A', status: 'polling_paused', generationReserved: true, remoteMayContinue: true, schedulingNotice: '远端可能仍在生成或计费', pauseReason: 'user_stopped' };
  const fetcher = vi.fn(async () => Response.json({ task })); vi.stubGlobal('fetch', fetcher);
  expect(await actOnWorkbenchTask('local/A', 'stop-polling')).toEqual(task);
  expect(fetcher).toHaveBeenCalledWith('/api/nova/tasks/local%2FA/stop-polling', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
});
it('attachment forwards the ID as data and cannot create another generation', async () => {
  const fetcher = vi.fn(async () => Response.json({ task: { status: 'polling_paused' } })); vi.stubGlobal('fetch', fetcher);
  await actOnWorkbenchTask('local-id', 'attach-upstream-id', { upstreamTaskId: 'known/opaque?ID' });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledWith('/api/nova/tasks/local-id/attach-upstream-id', expect.objectContaining({ method: 'POST', body: JSON.stringify({ upstreamTaskId: 'known/opaque?ID' }) }));
});
it('read-only task GET preserves remote_completed and never triggers creation', async () => {
  const remote = { id: 'local-id', status: 'remote_completed', outputAssets: [] };
  const fetcher = vi.fn(async () => Response.json(remote)); vi.stubGlobal('fetch', fetcher);
  expect(await getWorkbenchTask('local-id')).toEqual(remote); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledWith('/api/nova/tasks/local-id', { cache: 'no-store' });
});
it('a read failure is classified without generating a replacement', async () => {
  const fetcher = vi.fn(async () => Response.json({ code: 'TASK_NOT_FOUND', error: '找不到任务' }, { status: 404 })); vi.stubGlobal('fetch', fetcher);
  await expect(getWorkbenchTask('missing')).rejects.toBeInstanceOf(WorkbenchTaskActionError); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('canonical create sends one frozen intent with capability and ordered asset references, without reading current settings', async () => {
  const input = { localRequestId: 'intent-A', connectionVersionId: 'connection-A', capabilityVersionId: 'capability-A', mode: 'video.dual_reference' as const, model: 'grok-imagine-video-1.5-6s', prompt: '  中文\n“完整台词”  ', parameters: { seconds: 6, size: '1280x720' }, inputAssets: [{ assetId: 'asset-B', position: 0, role: 'reference' as const }, { assetId: 'asset-A', position: 1, role: 'reference' as const }] };
  const fetcher = vi.fn(async () => Response.json({ taskId: 'local-task' })); vi.stubGlobal('fetch', fetcher);
  expect(await createWorkbenchTask(input)).toBe('local-task');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith('/api/nova/workbench/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
});
it('canonical create preserves unverified capability rejection and never changes model or retries a lost POST', async () => {
  const input = { localRequestId: 'intent-A', connectionVersionId: 'connection-A', capabilityVersionId: 'capability-A', mode: 'image.text' as const, model: 'gpt-image-2.5-flare', prompt: '中文', parameters: {}, inputAssets: [] };
  const fetcher = vi.fn(async () => Response.json({ code: 'CAPABILITY_UNVERIFIED', error: '待受控验证' }, { status: 400 })); vi.stubGlobal('fetch', fetcher);
  await expect(createWorkbenchTask(input)).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED', statusCode: 400 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockRejectedValueOnce(new TypeError('lost ACK'));
  await expect(createWorkbenchTask(input)).rejects.toThrow('lost ACK'); expect(fetcher).toHaveBeenCalledTimes(2);
});
