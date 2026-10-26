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

it('does not refresh a new route from an old route, connection version or unrecorded historical failure',async()=>{
  const cn={...connection,routeSupported:true,route:'cn' as const,routeRevision:1},com={...cn,route:'com' as const,routeRevision:2};const failed={...task,connectionVersionId:'v1',transportRoute:{route:'cn' as const,revision:1}};
  const fetch=vi.fn(async()=>Response.json({...result(),routeSupported:true,route:'cn',routeRevision:1}));vi.stubGlobal('fetch',fetch);const accept=vi.fn();const h=renderHook(({selected,tasks})=>useRejectedModelRefresh(selected,tasks,accept),{initialProps:{selected:com as ConnectionSummary,tasks:[failed] as HistoryTask[]}});await act(async()=>{});expect(fetch).not.toHaveBeenCalled();h.rerender({selected:cn,tasks:[{...failed,connectionVersionId:'old'}]});expect(fetch).not.toHaveBeenCalled();h.rerender({selected:cn,tasks:[task]});expect(fetch).not.toHaveBeenCalled();h.rerender({selected:cn,tasks:[failed]});await waitFor(()=>expect(accept).toHaveBeenCalledTimes(1));expect(fetch).toHaveBeenCalledTimes(1);
});
it('ignores late models after a route change with an unchanged connection version',async()=>{
  let resolve!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));const accept=vi.fn();const cn={...connection,route:'cn' as const,routeRevision:1};const h=renderHook(({selected,tasks})=>useRejectedModelRefresh(selected,tasks,accept),{initialProps:{selected:cn as ConnectionSummary,tasks:[{...task,connectionVersionId:'v1',transportRoute:{route:'cn' as const,revision:1}}] as HistoryTask[]}});h.rerender({selected:{...cn,route:'com',routeRevision:2},tasks:[]});await act(async()=>resolve(Response.json({...result(),route:'cn',routeRevision:1})));expect(accept).not.toHaveBeenCalled();
});
