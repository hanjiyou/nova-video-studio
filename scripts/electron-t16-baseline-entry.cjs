'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const out=process.env.T16_BASELINE_OUTPUT;app.setPath('userData',path.join(out,'baseline-profile'));let win;
app.whenReady().then(async()=>{win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});await win.loadURL('data:text/html,<html><body>Electron baseline</body></html>');const value=await win.webContents.executeJavaScript('document.body.innerText');fs.writeFileSync(path.join(out,'baseline-result.json'),JSON.stringify({status:'passed',value,versions:process.versions}));app.exit(value==='Electron baseline'?0:2);}).catch(error=>{fs.writeFileSync(path.join(out,'baseline-result.json'),JSON.stringify({status:'failed',error:String(error)}));app.exit(1)});
setTimeout(()=>app.exit(3),20000);
