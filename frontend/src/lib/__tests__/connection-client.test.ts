import {afterEach,describe,expect,it,vi} from 'vitest';
import {saveConnection,desktopTaskPayload,checkConnection,sameConnectionTransport,type ConnectionSummary} from '@/lib/connection-client';
import {loadRegistry,saveRegistry} from '@/lib/nova-models';
import {getPluginCredential,setPluginCredential} from '@/lib/plugin-registry-client';
import {createNovaTask} from '@/lib/ccode-task-client';
import {createPluginTask} from '@/lib/plugin-task-client';
import {fetchUpstreamModels} from '@/lib/provider-models-client';
import type {InstalledPlugin} from '@/lib/plugin-schema';
const connection: ConnectionSummary={connectionId:'fixture-connection',connectionVersionId:'fixture-version',displayName:'共享图片视频',baseUrl:'https://fixture.invalid/v1',provider:'openai-compatible',protocol:'openai',hasCredential:true,credentialState:'ready',validationState:'unverified',lastCheckedAt:null,lastSuccessAt:null,modelsFetchedAt:null,errorCode:null,defaultImageModel:'gpt-image-2.5-flare',defaultVideoModel:'grok-imagine-video-1.5-6s',isDefault:true};
const desktop=()=>Object.defineProperty(window,'novaDesktop',{configurable:true,value:{}});
afterEach(()=>{delete window.novaDesktop;localStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('desktop credentials and connections',()=>{
  it('sends save secrets only to narrow IPC and releases its transient copy on success/failure',async()=>{
    let observed='';const ipc=vi.fn(async(input:{apiKey?:string})=>{observed=input.apiKey || '';return {ok:true,connection} as {ok:boolean;connection?:ConnectionSummary;code?:string};});
    Object.defineProperty(window,'novaDesktop',{configurable:true,value:{saveConnection:ipc}});const storage=vi.spyOn(Storage.prototype,'setItem');
    await expect(saveConnection({apiKey:'synthetic-secret',baseUrl:connection.baseUrl})).resolves.toEqual(connection);expect(observed).toBe('synthetic-secret');expect(ipc.mock.calls[0][0].apiKey).toBeUndefined();expect(storage).not.toHaveBeenCalled();
    ipc.mockImplementation(async()=>({ok:false,code:'CREDENTIAL_UNAVAILABLE'}));await expect(saveConnection({apiKey:'failure-secret'})).rejects.toThrow('CREDENTIAL_UNAVAILABLE');expect(ipc.mock.calls[1][0].apiKey).toBeUndefined();
  });
  it('neither reads nor migrates browser provider/plugin credentials and blocks further desktop writes',()=>{
    localStorage.setItem('nova-plugin-credentials',JSON.stringify({fixture:{apiKey:'old-secret'}}));desktop();const get=vi.spyOn(Storage.prototype,'getItem'),set=vi.spyOn(Storage.prototype,'setItem');
    const registry=loadRegistry();expect(registry.providers).toEqual([]);expect(get).not.toHaveBeenCalled();const plugin={id:'fixture',credential:{defaultBaseUrl:'https://fixture.invalid'}} as InstalledPlugin;
    expect(getPluginCredential(plugin).apiKey).toBe('');expect(get).not.toHaveBeenCalled();setPluginCredential('fixture',{apiKey:'new-secret'});expect(set).not.toHaveBeenCalled();expect(()=>saveRegistry(registry)).toThrow('受信连接接口');expect(set).not.toHaveBeenCalled();
  });
  it('strips caller credentials and honors an explicit task connection version without fallback',async()=>{
    desktop();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({connection})));expect(await desktopTaskPayload({apiKey:'never-http',baseUrl:'https://forged.invalid',protocol:'google',model:'exact-model'})).toEqual({model:'exact-model',connectionVersionId:connection.connectionVersionId,localRequestId:expect.any(String)});
    vi.mocked(fetch).mockClear();expect(await desktopTaskPayload({connectionVersionId:'explicit-old-version',apiKey:'never-http'})).toEqual({connectionVersionId:'explicit-old-version',localRequestId:expect.any(String)});expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects missing/decryption-unavailable connections before task POST',async()=>{
    desktop();for(const current of [null,{...connection,hasCredential:false,credentialState:'missing'},{...connection,credentialState:'unavailable'}]){vi.stubGlobal('fetch',vi.fn(async()=>Response.json({connection:current})));await expect(desktopTaskPayload({model:'exact-model'})).rejects.toThrow('凭据');expect(fetch).toHaveBeenCalledTimes(1);}
  });
  it('image and plugin/video clients share version references and send no raw keys',async()=>{
    desktop();const posted:Array<Record<string,unknown>>=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST'){posted.push(JSON.parse(String(init.body)));return Response.json({taskId:'local-fixture'});}return Response.json({connection});}));
    await createNovaTask({apiKey:'never-http',baseUrl:'https://forged.invalid',protocol:'openai',mode:'text-to-image',model:'gpt-image-2.5-flare',prompt:'中文\n原文',outputSize:'auto',aspectRatio:'auto',temperature:1,parallelCount:1,images:[]});
    await createPluginTask({pluginId:'fixture',apiKey:'never-http',baseUrl:'https://forged.invalid',model:'grok-imagine-video-1.5-6s',facets:{},fields:{prompt:'中文\n原文'},media:{}});
    expect(posted).toHaveLength(2);expect(posted.every(body=>body.connectionVersionId===connection.connectionVersionId)).toBe(true);expect(JSON.stringify(posted)).not.toContain('never-http');expect(JSON.stringify(posted)).not.toContain('forged.invalid');
  });
  it('refreshes models using only connection version and needs no text model',async()=>{
    desktop();const calls:Array<{url:string;body:unknown}>=[];vi.stubGlobal('fetch',vi.fn(async(url,init)=>{calls.push({url:String(url),body:init?.body});return String(url).endsWith('/current')?Response.json({connection}):Response.json({stale:false,cached:false,connection:{...connection,validationState:'verified'},models:[{model:connection.defaultImageModel,visibility:'visible'}]});}));
    expect(await fetchUpstreamModels({apiKey:'never-http',baseUrl:'https://forged.invalid',protocol:'openai'})).toEqual([connection.defaultImageModel]);expect(calls[1].url).toBe('/api/nova/connections/fixture-connection/check');expect(JSON.parse(String(calls[1].body))).toEqual({connectionVersionId:connection.connectionVersionId,force:true});expect(JSON.stringify(calls)).not.toContain('never-http');await checkConnection(connection);expect(JSON.parse(String(calls[2].body)).connectionVersionId).toBe(connection.connectionVersionId);
  });
});

it('binds model checks and replies to the selected route revision without upgrading capability evidence',async()=>{
  const current={...connection,routeSupported:true,route:'cn' as const,routeRevision:3};vi.stubGlobal('fetch',vi.fn(async()=>Response.json({})));await checkConnection(current,true,'startup');expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({connectionVersionId:connection.connectionVersionId,expectedRouteRevision:3,force:true,reason:'startup'});
  const models={connectionVersionId:connection.connectionVersionId,modelsFetchedAt:null,models:[],capabilities:[],route:'cn' as const,routeRevision:3,transportEvidence:'generation_unverified' as const};expect(sameConnectionTransport(current,models)).toBe(true);expect(sameConnectionTransport(current,{...models,route:'com'})).toBe(false);expect(sameConnectionTransport(current,{...models,routeRevision:1})).toBe(false);expect(sameConnectionTransport(current,{...models,routeRevision:undefined})).toBe(false);expect(sameConnectionTransport(connection,{...models,routeRevision:undefined})).toBe(true);expect(sameConnectionTransport(current,{...models,connectionVersionId:'old'})).toBe(false);
});
