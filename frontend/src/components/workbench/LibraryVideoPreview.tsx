'use client';
import { useEffect, useRef, useState } from 'react';
let activeStop:(()=>void)|null=null;
export function stopLibraryPreviews() { activeStop?.();activeStop=null;if(typeof window!=='undefined')window.dispatchEvent(new Event('nova-library-preview-stop')); }
export function LibraryVideoPreview({src,disabled=false}:{src:string;disabled?:boolean}) {
 const root=useRef<HTMLDivElement>(null),video=useRef<HTMLVideoElement>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),epoch=useRef(0),hovered=useRef(false),lastPlay=useRef(0),claim=useRef<(()=>void)|null>(null);
 const focused=useRef(typeof document!=='undefined'&&document.hasFocus());
 const [visible,setVisible]=useState(()=>typeof IntersectionObserver==='undefined'),[attached,setAttached]=useState(()=>!disabled&&typeof IntersectionObserver==='undefined'),[playing,setPlaying]=useState(false),[error,setError]=useState(false),[poster,setPoster]=useState('');
 const permitted=useRef<()=>boolean>(()=>false);permitted.current=()=>!disabled&&visible&&focused.current&&!document.hidden;
 const stop=useRef((release=false)=>{void release;});
 stop.current=(release=false)=>{
  hovered.current=false;epoch.current++;clearTimeout(timer.current);const player=video.current;
  if(player){player.pause();try{player.currentTime=0.05;}catch{}if(release){player.removeAttribute('src');player.load();}}
  if(activeStop===claim.current)activeStop=null;claim.current=null;setPlaying(false);if(release)setAttached(false);
 };
 useEffect(()=>{const element=root.current;if(!element||typeof IntersectionObserver==='undefined')return;const observer=new IntersectionObserver(entries=>setVisible(Boolean(entries[0]?.isIntersecting)),{threshold:0.05});observer.observe(element);return()=>observer.disconnect();},[]);
 useEffect(()=>{setError(false);setPoster('');},[src]);
 useEffect(()=>{if(permitted.current())setAttached(true);else stop.current(true);},[disabled,visible,src]);
 useEffect(()=>{
  const release=()=>{focused.current=false;stop.current(true);},hide=()=>{if(document.hidden)stop.current(true);else{focused.current=document.hasFocus();if(permitted.current())setAttached(true);}},focus=()=>{focused.current=true;if(permitted.current())setAttached(true);},stopEvent=()=>stop.current(true);
  window.addEventListener('blur',release);window.addEventListener('nova-library-preview-stop',stopEvent);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',hide);
  return()=>{window.removeEventListener('blur',release);window.removeEventListener('nova-library-preview-stop',stopEvent);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',hide);clearTimeout(timer.current);epoch.current++;const player=video.current;if(player){player.pause();player.removeAttribute('src');player.load();}if(activeStop===claim.current)activeStop=null;};
 },[]);
 function enter(){
  if(!permitted.current()||error)return;hovered.current=true;setAttached(true);clearTimeout(timer.current);
  const ticket=++epoch.current;
  timer.current=setTimeout(()=>{if(ticket!==epoch.current||!hovered.current||!permitted.current())return;
   const halt=()=>stop.current(false);activeStop?.();activeStop=halt;claim.current=halt;const player=video.current;if(!player)return;
   player.muted=true;player.loop=true;lastPlay.current=ticket;
   void player.play().then(()=>{if(ticket!==epoch.current||!hovered.current||!permitted.current()){if(lastPlay.current===ticket)player.pause();return;}setPlaying(true);}).catch(()=>{if(ticket===epoch.current&&hovered.current){setError(true);stop.current(false);}});
  },250);
 }
 function cover(){
  const player=video.current;if(!player||poster||typeof CanvasRenderingContext2D==='undefined')return;
  try {const canvas=document.createElement('canvas');canvas.width=Math.min(480,player.videoWidth);canvas.height=Math.round(canvas.width*player.videoHeight/player.videoWidth);const context=canvas.getContext('2d');if(context&&canvas.width&&canvas.height){context.drawImage(player,0,0,canvas.width,canvas.height);setPoster(canvas.toDataURL('image/jpeg',0.75));}}catch{}
 }
 return <div ref={root} className="wb-hover-video" data-hover-playing={playing||undefined} onMouseEnter={enter} onMouseLeave={()=>stop.current(false)}>
  <video ref={video} src={attached?src:undefined} poster={poster||undefined} muted playsInline loop preload="metadata" aria-label="本机视频作品缩略预览" onLoadedMetadata={event=>{if(!hovered.current)try{event.currentTarget.currentTime=Math.min(0.05,event.currentTarget.duration/2);}catch{}}} onLoadedData={cover} onSeeked={cover} onError={()=>{if(attached){setError(true);stop.current(true);}}}/>
  {playing&&<span className="wb-hover-playing">静音预览</span>}{error&&<span className="wb-hover-error" role="status">暂无法播放，双击查看详情</span>}
 </div>;
}
