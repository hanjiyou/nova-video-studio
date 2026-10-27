import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AppUpdate,UpdateNotice} from '../AppUpdate';
import {ConnectionForm} from '../ConnectionForm';
import {useAppUpdate} from '@/hooks/useAppUpdate';
import {useWorkbenchDrafts} from '@/hooks/useWorkbenchDrafts';
import {DRAFT_MODES} from '@/lib/workbench-client';
import {hasUpdateBlockers,registerUpdateBlocker,setUpdateFrozen} from '@/lib/update-readiness';
import type {AppUpdateState} from '@/lib/app-update';
const downloaded:AppUpdateState={supported:true,currentVersion:'3.5.2',phase:'downloaded',installSupported:true,notice:null,remoteMayContinue:true,update:{version:'3.5.3',releaseNotes:'<img src=x onerror=alert(1)> [unsafe](https://evil.invalid)'}};
function deferred<T>() {let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
let stateListener:(s:AppUpdateState)=>void,flushListener:(r:{id:string})=>void;
let bridge:ReturnType<typeof api>;
function api(){return {getUpdateState:vi.fn(async()=>downloaded),onUpdateState:vi.fn((cb:typeof stateListener)=>{stateListener=cb;return vi.fn();}),onUpdateFlush:vi.fn((cb:typeof flushListener)=>{flushListener=cb;return vi.fn();}),acknowledgeUpdateFlush:vi.fn(async()=>({ok:true})),installUpdate:vi.fn(async()=>({ok:false})),downloadUpdate:vi.fn(async()=>({ok:true})),checkForUpdates:vi.fn(async()=>({ok:true})),dismissUpdateNotice:vi.fn(async()=>({ok:true}))};}
beforeEach(()=>{bridge=api();window.novaDesktop=bridge as unknown as Window['novaDesktop'];});
afterEach(()=>{cleanup();delete window.novaDesktop;setUpdateFrozen(false);vi.restoreAllMocks();vi.unstubAllGlobals();});
it('renders release notes as literal text, has explicit install, and never installs upon download state',()=>{
 const install=vi.fn(async()=>{});render(<AppUpdate state={downloaded} onInstall={install}/>);expect(install).not.toHaveBeenCalled();expect(document.querySelector('img')).toBeNull();expect(document.querySelector('a')).toBeNull();expect(screen.getByRole('button',{name:'重启并安装'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'稍后'}));expect(bridge.dismissUpdateNotice).toHaveBeenCalled();expect(install).not.toHaveBeenCalled();
});
it('never requires a connection/key for update; only edited or in-flight connection input blocks installation',()=>{
 render(<><ConnectionForm connection={null} onSaved={vi.fn()} onModels={vi.fn()}/><AppUpdate state={downloaded} onInstall={vi.fn(async()=>{})}/></>);expect(hasUpdateBlockers()).toBe(false);expect(screen.getByRole('button',{name:'重启并安装'})).toBeEnabled();fireEvent.change(screen.getByLabelText('连接名称'),{target:{value:'尚未保存'}});expect(hasUpdateBlockers()).toBe(true);expect(screen.getByRole('button',{name:'重启并安装'})).toBeDisabled();
});
it('override download remains visible but install is disabled with a readable data-directory reason',()=>{render(<AppUpdate state={{...downloaded,installSupported:false,installReason:'DATA_DIRECTORY_RESTART_UNPROVEN'}} onInstall={vi.fn(async()=>{})}/>);expect(screen.getByRole('button',{name:'重启并安装'})).toBeDisabled();expect(screen.getByText(/当前使用自定义资料目录/)).toBeInTheDocument();});
it('snapshot handles a late subscriber and notification dismiss does not run another check',async()=>{const hook=renderHook(()=>useAppUpdate(vi.fn(async()=>{}),true));await waitFor(()=>expect(hook.result.current.state?.phase).toBe('downloaded'));render(<UpdateNotice state={{...downloaded,notice:'3.5.3'}} onOpen={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'关闭更新提示'}));expect(bridge.dismissUpdateNotice).toHaveBeenCalledTimes(1);expect(bridge.checkForUpdates).not.toHaveBeenCalled();});
it('flush freezes immediately and acknowledges only after all asynchronous persistence resolves',async()=>{
 const pending=deferred<void>(),flush=vi.fn(()=>pending.promise),hook=renderHook(()=>useAppUpdate(flush,true));await waitFor(()=>expect(bridge.onUpdateFlush).toHaveBeenCalled());act(()=>flushListener({id:'request-1'}));expect(hook.result.current.frozen).toBe(true);expect(bridge.acknowledgeUpdateFlush).not.toHaveBeenCalled();await act(async()=>pending.resolve());expect(bridge.acknowledgeUpdateFlush).toHaveBeenCalledWith({id:'request-1',ok:true});
 act(()=>stateListener({...downloaded,error:{code:'UPDATE_SAVE_FAILED',message:'未保存'}}));expect(hook.result.current.frozen).toBe(false);
});
it('flush failure or pending local intent sends a negative acknowledgement and never claims save success',async()=>{
 const remove=registerUpdateBlocker(()=>true),flush=vi.fn(async()=>{});renderHook(()=>useAppUpdate(flush,true));await waitFor(()=>expect(bridge.onUpdateFlush).toHaveBeenCalled());await act(async()=>flushListener({id:'busy'}));expect(flush).not.toHaveBeenCalled();expect(bridge.acknowledgeUpdateFlush).toHaveBeenCalledWith({id:'busy',ok:false});remove();cleanup();bridge.acknowledgeUpdateFlush.mockClear();renderHook(()=>useAppUpdate(async()=>{throw Error('disk');},true));await act(async()=>flushListener({id:'save-failed'}));expect(bridge.acknowledgeUpdateFlush).toHaveBeenCalledWith({id:'save-failed',ok:false});
});
function draftApi(first?:Promise<Response>){const drafts=new Map(DRAFT_MODES.map(mode=>[mode,{mode,prompt:'',model:'',parameters:{},inputAssets:[],revision:0,updatedAt:null}]));let writes=0;vi.stubGlobal('fetch',vi.fn(async(route:string,options?:RequestInit)=>{const mode=route.split('/').pop()! as typeof DRAFT_MODES[number];if(options?.method==='PUT'){writes++;if(writes===1&&first)return first;const sent=JSON.parse(String(options.body));drafts.set(mode,{...drafts.get(mode)!,...sent,revision:sent.expectedRevision+1});}return Response.json({draft:drafts.get(mode)});}));return drafts;}
it('four-mode flush waits for an in-flight save and the later edited revision without losing content',async()=>{
 const first=deferred<Response>();draftApi(first.promise);const h=renderHook(useWorkbenchDrafts);await act(async()=>h.result.current.load());act(()=>h.result.current.update('image.text',{prompt:'before'}));await waitFor(()=>expect(fetch).toHaveBeenCalledWith(expect.stringContaining('image.text'),expect.objectContaining({method:'PUT'})));act(()=>h.result.current.update('image.text',{prompt:'after'}));let completed=false;let flush!:Promise<void>;act(()=>{flush=h.result.current.flush().then(()=>{completed=true;});});expect(completed).toBe(false);await act(async()=>{first.resolve(Response.json({draft:{mode:'image.text',prompt:'before',model:'',parameters:{},inputAssets:[],revision:1,updatedAt:null}}));await flush;});expect(completed).toBe(true);expect(h.result.current.drafts['image.text']?.prompt).toBe('after');expect(h.result.current.drafts['image.text']?.revision).toBe(2);
});
it('failed draft persistence rejects flush and retains the latest edit for explicit retry',async()=>{
 draftApi();const h=renderHook(useWorkbenchDrafts);await act(async()=>h.result.current.load());vi.stubGlobal('fetch',vi.fn(async()=>Response.json({code:'STORAGE_OPERATION_FAILED'},{status:500})));act(()=>h.result.current.update('video.text',{prompt:'must survive'}));await act(async()=>{await expect(h.result.current.flush()).rejects.toThrow('UPDATE_SAVE_FAILED');});expect(h.result.current.drafts['video.text']?.prompt).toBe('must survive');expect(h.result.current.errors['video.text']).toBeTruthy();
});
it('a closed-backend install failure keeps creation frozen and does not claim normal operation recovered',async()=>{
 bridge.installUpdate.mockResolvedValue({ok:false,state:{...downloaded,phase:'closed-error'}} as never);const h=renderHook(()=>useAppUpdate(async()=>{},true));await waitFor(()=>expect(h.result.current.state).toBeTruthy());await act(async()=>h.result.current.install());expect(h.result.current.frozen).toBe(true);expect(h.result.current.state?.phase).toBe('closed-error');
});
it('an asynchronous closed-error event keeps the creation surface frozen',async()=>{
 const h=renderHook(()=>useAppUpdate(async()=>{},true));await waitFor(()=>expect(h.result.current.state).toBeTruthy());act(()=>stateListener({...downloaded,phase:'closed-error',error:{code:'UPDATE_INSTALL_FAILED',message:'安装尚未完成'}}));expect(h.result.current.frozen).toBe(true);
});
it('check IPC transport rejection is absorbed and offers a fixed retry message',async()=>{
 bridge.checkForUpdates.mockRejectedValue(Error('private path and URL'));render(<AppUpdate state={{...downloaded,phase:'idle',update:undefined}} onInstall={vi.fn(async()=>{})}/>);fireEvent.click(screen.getByRole('button',{name:'检查更新'}));expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法执行更新操作，请稍后重试。');expect(screen.getByRole('button',{name:'检查更新'})).toBeEnabled();
});

it('identifies the unsigned GitHub test build in settings',()=>{render(<AppUpdate state={{...downloaded,testBuild:true,currentVersion:'3.6.0'}} onInstall={vi.fn(async()=>{})}/>);expect(screen.getByText('GitHub 更新测试版 · 未签名')).toBeInTheDocument();});


it('shows an attempt until real differential progress and labels the updater byte denominator without savings claims',()=>{
 const state:AppUpdateState={...downloaded,phase:'downloading',remoteMayContinue:false,downloadMode:'differential-attempt'};
 const view=render(<AppUpdate state={state} onInstall={vi.fn(async()=>{})}/>);
 expect(screen.getByText('正在尝试差量更新…')).toBeInTheDocument();expect(screen.getByText(/尚未确认差量下载/)).toBeInTheDocument();expect(document.body).not.toHaveTextContent('节省');
 view.rerender(<AppUpdate state={{...state,downloadMode:'differential',progress:{transferred:250,total:1000,percent:25,bytesPerSecond:10}}} onInstall={vi.fn(async()=>{})}/>);
 expect(screen.getByText('正在下载差量更新 · 25%')).toBeInTheDocument();expect(screen.getByText('本阶段已传输 250 B / 1.0 KB')).toBeInTheDocument();expect(screen.getByText(/不含本地复用字节/)).toBeInTheDocument();expect(document.body).not.toHaveTextContent('节省');
 view.rerender(<AppUpdate state={{...state,downloadMode:'full-fallback',fallbackReason:'checksum_failed'}} onInstall={vi.fn(async()=>{})}/>);
 expect(screen.getByText('已回退为完整包下载…')).toBeInTheDocument();expect(document.body).not.toHaveTextContent('25%');expect(document.body).not.toHaveTextContent('1.0 KB');expect(screen.getByText(/应用已自动改为下载完整安装包/)).toBeInTheDocument();
 view.rerender(<AppUpdate state={{...state,downloadMode:'full-fallback',progress:{transferred:100,total:10000,percent:1}}} onInstall={vi.fn(async()=>{})}/>);
 expect(screen.getByText('本阶段已传输 100 B / 10.0 KB')).toBeInTheDocument();
});
it('explicitly explains full download when the installed baseline is unavailable, and tolerates legacy states',()=>{
 const state:AppUpdateState={...downloaded,phase:'downloading',downloadMode:'full',baselineReason:'baseline_missing'};
 const view=render(<AppUpdate state={state} onInstall={vi.fn(async()=>{})}/>);
 expect(screen.getByText('正在下载完整安装包…')).toBeInTheDocument();expect(screen.getByText(/当前版本的差量基础包不可用/)).toBeInTheDocument();
 view.rerender(<AppUpdate state={{...downloaded,phase:'downloading',progress:{percent:20,transferred:4}}} onInstall={vi.fn(async()=>{})}/>);
 expect(screen.getByText('正在下载更新 · 20%')).toBeInTheDocument();expect(screen.getByText('本阶段已传输 4 B')).toBeInTheDocument();expect(document.body).not.toHaveTextContent('差量更新');expect(document.body).not.toHaveTextContent('完整包缓存');
});
it('confirms full cache reuse only when the host reports it and keeps installation explicit',()=>{
 const install=vi.fn(async()=>{}),view=render(<AppUpdate state={{...downloaded,downloadMode:'cached'}} onInstall={install}/>);
 expect(screen.getByText(/已复用完整安装包缓存/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'重启并安装'})).toBeEnabled();expect(install).not.toHaveBeenCalled();
 view.rerender(<AppUpdate state={{...downloaded,downloadMode:'differential'}} onInstall={install}/>);
 expect(screen.queryByText(/已复用完整安装包缓存/)).not.toBeInTheDocument();expect(screen.getByText(/更新已下载/)).toBeInTheDocument();expect(install).not.toHaveBeenCalled();
});
it('zero-change differential plans never render a false transfer percentage, NaN or Infinity',()=>{
 render(<AppUpdate state={{...downloaded,phase:'downloading',downloadMode:'differential-attempt',progress:{transferred:0,total:0,percent:100}}} onInstall={vi.fn(async()=>{})}/>);
 expect(screen.getByText('正在尝试差量更新…')).toBeInTheDocument();expect(screen.getByText('本阶段已传输 0 B / 0 B')).toBeInTheDocument();expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');expect(document.body).not.toHaveTextContent('100%');expect(document.body).not.toHaveTextContent('NaN');expect(document.body).not.toHaveTextContent('Infinity');
});

it('formats installer byte counts using the same decimal units as workbench downloads',()=>{
 render(<AppUpdate state={{...downloaded,phase:'downloading',downloadMode:'full-fallback',progress:{transferred:133795485,total:133795485,percent:100}}} onInstall={vi.fn(async()=>{})}/>);
 expect(screen.getByText('本阶段已传输 133.8 MB / 133.8 MB')).toBeInTheDocument();expect(document.body).not.toHaveTextContent('133,795,485');
});
