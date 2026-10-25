import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRejectedModelRefresh } from '@/hooks/useRejectedModelRefresh';
import type { ConnectionSummary } from '@/lib/connection-client';
import type { HistoryTask } from '@/lib/workbench-client';
const connection={connectionVersionId:'v1',connectionId:'c1'} as ConnectionSummary;
const task={localTaskId:'t1',taskError:{code:'MODEL_UNAVAILABLE'}} as HistoryTask;
const result=(version='v1',error:string|null=null)=>({connectionVersionId:version,stale:false,cached:false,modelsFetchedAt:'2026-10-25T00:00:00Z',models:[{model:'fixture',visibility:'absent'}],capabilities:[],refreshError:error,connection:{validationState:error?'offline':'verified'}});
let now=100000;
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('waits for refresh, deduplicates history ticks, and acknowledges only the synchronized result',async()=>{
  let resolve!:(r:Response)=>void;
  const fetch=vi.fn(()=>new Promise<Response>(r=>{resolve=r;}));vi.stubGlobal('fetch',fetch);
  const accept=vi.fn();const hook=renderHook(({tasks})=>useRejectedModelRefresh(connection,tasks,accept),{initialProps:{tasks:[task]}});
  hook.rerender({tasks:[task]});expect(fetch).toHaveBeenCalledTimes(1);expect(accept).not.toHaveBeenCalled();
  await act(async()=>resolve(Response.json(result())));
  expect(accept).toHaveBeenCalledWith(expect.objectContaining({models:[{model:'fixture',visibility:'absent'}]}));
  hook.rerender({tasks:[task]});expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['transport','catalog'])('retries %s failure only after backoff and does not acknowledge failed sync',async failure=>{
  now=100000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const fetch=vi.fn().mockImplementationOnce(()=>failure==='transport'?Promise.reject(Error('offline')):Promise.resolve(Response.json(result('v1','CONNECTION_OFFLINE')))).mockResolvedValue(Response.json(result()));vi.stubGlobal('fetch',fetch);
  const accept=vi.fn();const hook=renderHook(({tasks})=>useRejectedModelRefresh(connection,tasks,accept),{initialProps:{tasks:[task]}});
  await act(async()=>{});expect(accept).not.toHaveBeenCalled();
  now+=29999;hook.rerender({tasks:[task]});expect(fetch).toHaveBeenCalledTimes(1);
  now++;hook.rerender({tasks:[task]});await waitFor(()=>expect(accept).toHaveBeenCalledTimes(1));expect(fetch).toHaveBeenCalledTimes(2);
  hook.rerender({tasks:[task]});expect(fetch).toHaveBeenCalledTimes(2);
});
it('ignores late results after switching connections',async()=>{
  let resolve!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));
  const accept=vi.fn();const hook=renderHook(({selected,tasks})=>useRejectedModelRefresh(selected,tasks,accept),{initialProps:{selected:connection,tasks:[task]}});
  hook.rerender({selected:{...connection,connectionVersionId:'v2'},tasks:[]});
  await act(async()=>resolve(Response.json(result())));expect(accept).not.toHaveBeenCalled();
});
