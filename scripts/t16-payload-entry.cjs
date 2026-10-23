'use strict';
// Run by the installed Electron executable with ELECTRON_RUN_AS_NODE, outside the app.
// Exercises its actual bundled SQLite and diagnostics collector; no SaveDialog claim.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [archive,dbPath,output]=process.argv.slice(2);
const Database=require(path.join(archive,'node_modules/better-sqlite3'));
const {createDiagnostics}=require(path.join(archive,'backend/storage/diagnostics.js'));
const db=new Database(dbPath,{readonly:true,fileMustExist:true}),report=createDiagnostics(db,{version:require(path.join(archive,'package.json')).version});db.close();
const text=JSON.stringify(report);
for(const forbidden of['t16-synthetic-only-not-a-real-key','T16 中文路径','127.0.0.1',dbPath,'credentialRef','ciphertext','previewUrl'])assert.ok(!text.includes(forbidden),forbidden);
assert.equal(report.format,'nova-diagnostics-v1');assert.equal(report.counts.tasks,5);assert.equal(report.application.version,'3.4.0');assert.equal(process.versions.electron,'43.4.0');
fs.writeFileSync(output,JSON.stringify({status:'passed',scope:'Installed package collector in its bundled Electron Node mode; actual JSON write to explicit isolated harness target, not system SaveDialog/IPC',runtime:process.versions,diagnostics:report},null,2)+'\n');
