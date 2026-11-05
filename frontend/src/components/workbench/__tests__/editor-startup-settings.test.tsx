import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EditorStartupSettings} from '../EditorStartupSettings';
import {hasUpdateBlockers,setUpdateFrozen} from '@/lib/update-readiness';
let record:{key:string;value:{startupTimeoutSeconds:number};revision:number;updatedAt:null},conflict:boolean;
let writes:number;
beforeEach(()=>{
  setUpdateFrozen(false);record={key:'editor',value:{startupTimeoutSeconds:90},revision:0,updatedAt:null};conflict=false;writes=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    expect(url).toBe('/api/nova/storage/settings/editor');
    if(options?.method==='PUT'){
      writes++;const body=JSON.parse(String(options.body));
      if(conflict||body.expectedRevision!==record.revision)return Response.json({code:'SETTING_REVISION_CONFLICT'},{status:409});
      record={...record,value:body.value,revision:record.revision+1};
    }
    return Response.json({setting:record});
  }));
});
afterEach(()=>{cleanup();setUpdateFrozen(false);vi.unstubAllGlobals();});
const input=()=>screen.getByRole('spinbutton',{name:'剪辑启动超时（秒）'});
async function loaded(){await waitFor(()=>expect(input()).toBeEnabled());}
it('loads 90 seconds, saves a number with revision and restores after remount',async()=>{
  const view=render(<EditorStartupSettings/>);await loaded();expect(input()).toHaveValue(90);
  fireEvent.change(input(),{target:{value:'120'}});expect(hasUpdateBlockers()).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'保存剪辑设置'}));
  expect(await screen.findByRole('status')).toHaveTextContent('下次启动剪辑时生效');expect(record.value.startupTimeoutSeconds).toBe(120);expect(record.revision).toBe(1);expect(hasUpdateBlockers()).toBe(false);
  view.unmount();render(<EditorStartupSettings/>);await loaded();expect(input()).toHaveValue(120);
});
it('rejects empty, fractional and out-of-range values without a save request',async()=>{
  render(<EditorStartupSettings/>);await loaded();
  for(const value of ['', '29','301','60.5']){fireEvent.change(input(),{target:{value}});expect(screen.getByRole('button',{name:'保存剪辑设置'})).toBeDisabled();}
  expect(writes).toBe(0);for(const value of ['30','300']){fireEvent.change(input(),{target:{value}});expect(screen.getByRole('button',{name:'保存剪辑设置'})).toBeEnabled();}
});
it('preserves conflicting input and requires a reload before saving again',async()=>{
  render(<EditorStartupSettings/>);await loaded();conflict=true;fireEvent.change(input(),{target:{value:'180'}});fireEvent.click(screen.getByRole('button',{name:'保存剪辑设置'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('你的输入已保留');expect(input()).toHaveValue(180);expect(screen.getByRole('button',{name:'保存剪辑设置'})).toBeDisabled();
  record={...record,value:{startupTimeoutSeconds:240},revision:1};conflict=false;fireEvent.click(screen.getByRole('button',{name:'重新读取剪辑设置'}));
  await waitFor(()=>expect(input()).toHaveValue(240));expect(screen.getByRole('button',{name:'保存剪辑设置'})).toBeEnabled();
});
it('respects update freeze and releases the unsaved-settings blocker on unmount',async()=>{
  const view=render(<EditorStartupSettings/>);await loaded();fireEvent.change(input(),{target:{value:'150'}});expect(hasUpdateBlockers()).toBe(true);
  setUpdateFrozen(true);fireEvent.click(screen.getByRole('button',{name:'保存剪辑设置'}));expect(writes).toBe(0);view.unmount();expect(hasUpdateBlockers()).toBe(false);
});
