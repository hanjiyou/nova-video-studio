'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
module.exports=async context=>{
    // Reject cross-platform packaging with the wrong host binary instead of silently
    // shipping an executable downloaded for the build machine.
    const platform=context.electronPlatformName,arch=require('builder-util').Arch[context.arch],key=platform+'-'+arch;
    const manifest=require('../desktop/ffmpeg-runtime.json'),record=manifest[key];
    if(!record)throw new Error('Media decoder packaging audit is required for target '+key);
    const directory=path.join(context.packager.info.appDir,'node_modules/ffmpeg-static'),file=path.join(directory,'ffmpeg.exe');
    if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==record.sha256)throw new Error('Media decoder binary does not match the audited target');
    for(const suffix of['.README','.LICENSE'])if(!fs.statSync(file+suffix).size)throw new Error('Media decoder license/build notice missing');
};
