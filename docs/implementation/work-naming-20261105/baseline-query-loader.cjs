'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const actual=path.resolve(__dirname,'../../../backend/storage/workbench-query.js');
const key=require.resolve(actual),loaded=new Module(key,module);
loaded.filename=key;loaded.paths=Module._nodeModulePaths(path.dirname(key));
loaded._compile(fs.readFileSync(path.join(__dirname,'baseline-workbench-query.js'),'utf8'),key);loaded.loaded=true;require.cache[key]=loaded;
