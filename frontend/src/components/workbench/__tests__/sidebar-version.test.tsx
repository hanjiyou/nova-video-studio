import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {SidebarVersion} from '../AppUpdate';
import type {AppUpdateState} from '@/lib/app-update';
afterEach(cleanup);
it('shows actual current version, not offered update, and opens update settings',()=>{
 const onOpen=vi.fn(),state={currentVersion:'3.6.3',testBuild:true,update:{version:'3.6.4',releaseNotes:''}} as AppUpdateState;
 const view=render(<SidebarVersion state={state} onOpen={onOpen}/>);const button=screen.getByRole('button',{name:'v3.6.3 · 测试版，查看版本与更新'});expect(button).toHaveTextContent('v3.6.3 · 测试版');expect(screen.queryByText(/3.6.4/)).toBeNull();fireEvent.click(button);expect(onOpen).toHaveBeenCalledOnce();
 view.rerender(<SidebarVersion state={{...state,testBuild:false,currentVersion:'3.7.0'}} onOpen={onOpen}/>);expect(screen.getByRole('button')).toHaveTextContent('v3.7.0');expect(screen.queryByText(/测试版/)).toBeNull();
});
it('does not invent a package version before runtime metadata arrives or in standalone mode',()=>{
 const view=render(<SidebarVersion state={null} onOpen={()=>{}}/>);expect(screen.getByRole('button',{name:'版本信息，查看版本与更新'})).toBeInTheDocument();view.rerender(<SidebarVersion state={{currentVersion:'unknown'} as AppUpdateState} onOpen={()=>{}}/>);expect(screen.getByRole('button')).toHaveTextContent('版本信息');expect(screen.queryByText(/3.4.0/)).toBeNull();
});
