'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { failure } = require('./download-errors');
function mediaType(bytes) {
    if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mimeType:'image/png', demuxer:'png_pipe', kind:'image' };
    if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return { mimeType:'image/jpeg', demuxer:'jpeg_pipe', kind:'image' };
    if (bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return { mimeType:'image/webp', demuxer:'webp_pipe', kind:'image' };
    if (/^GIF8[79]a/.test(bytes.toString('ascii',0,6))) return { mimeType:'image/gif', demuxer:'gif', kind:'image' };
    if (bytes.toString('ascii',4,8)==='ftyp') return { mimeType:'video/mp4', demuxer:'mov', kind:'video' };
    if (bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return { mimeType:'video/webm', demuxer:'matroska', kind:'video' };
    throw failure('MEDIA_INVALID');
}
function binaryPath() {
    // Never consult PATH or FFMPEG_BIN. The package's fixed, audited binary is required.
    const path = require('node:path');
    const file = path.join(path.dirname(require.resolve('ffmpeg-static/package.json')), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
async function validateMedia(file, { expectedKind, signal, timeoutMs = 90000 } = {}) {
    const bytes = fs.readFileSync(file), type = mediaType(bytes);
    if (expectedKind && type.kind !== expectedKind) throw failure('MEDIA_INVALID');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let binary;
    try { binary = binaryPath(); if (fs.statSync(binary).size < 1000000) throw new Error(); } catch { throw failure('MEDIA_VALIDATOR_UNAVAILABLE'); }
    return new Promise((resolve,reject) => {
        // Explicit demuxer prevents playlist/local-file indirection. There is one local input,
        // no network protocol, no stdin, bounded CPU threads/allocation, duration and output.
        const child = spawn(binary, ['-nostdin','-hide_banner','-v','error','-xerror','-max_alloc','268435456',
            '-threads','2','-err_detect','crccheck+bitstream+buffer+explode','-protocol_whitelist','file','-f',type.demuxer,...(type.demuxer==='mov'?['-enable_drefs','0']:[]),'-i',file,
            '-map','0:v:0','-map','0:a?','-threads','1','-f','framehash','-hash','sha256','pipe:1'], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
        let pending='', width=0, height=0, frames=0, duration=0, total=0, stderrBytes=0, invalid=false, unavailable=false;
        const bases = new Map();
        const stop = () => { invalid=true; child.kill(); };
        const timer=setTimeout(stop,timeoutMs); signal?.addEventListener('abort',stop,{once:true}); if(signal?.aborted)stop();
        function line(raw) {
            let match=raw.match(/^#dimensions\s+0:\s+(\d+)x(\d+)/);
            if(match){width=Number(match[1]);height=Number(match[2]);if(width*height>67108864)stop();}
            match=raw.match(/^#tb\s+(\d+):\s+(\d+)\/(\d+)/);
            if(match)bases.set(Number(match[1]),Number(match[2])/Number(match[3]));
            if(raw.startsWith('#'))return;
            const values=raw.split(',').map(value=>value.trim());
            if(values.length!==6)return;
            const stream=Number(values[0]),pts=Number(values[2]),length=Number(values[3]),base=bases.get(stream);
            if(stream===0)frames++;
            if(Number.isFinite(pts)&&Number.isFinite(length)&&base)duration=Math.max(duration,(pts+length)*base);
            if(frames>250000||duration>1800||frames*width*height>100000000000)stop();
        }
        child.stdout.on('data',chunk=>{
            total+=chunk.length;if(total>32*1024*1024){stop();return;}
            pending+=chunk.toString('utf8');const lines=pending.split('\n');pending=lines.pop();for(const raw of lines)line(raw);
            if(pending.length>8192)stop();
        });
        // Error output is never propagated: it may contain local paths or media metadata.
        child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop();});
        child.once('error',()=>{unavailable=true;});
        child.once('close',code=>{
            clearTimeout(timer);signal?.removeEventListener('abort',stop);line(pending);
            if(unavailable){reject(failure('MEDIA_VALIDATOR_UNAVAILABLE'));return;}
            if(code!==0||invalid||!frames||!width||!height||type.kind==='video'&&!(duration>0)){reject(failure('MEDIA_INVALID'));return;}
            resolve({ ...type, width,height,durationSeconds:type.kind==='video'?duration:null,sha256,decodedFrames:frames });
        });
    });
}
module.exports = { validateMedia, mediaType, binaryPath };
