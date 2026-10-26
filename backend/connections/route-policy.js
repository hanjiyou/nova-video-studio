'use strict';
// Identity stays immutable; only these two explicitly approved HTTPS service aliases route.
const BASES=Object.freeze({cn:'https://newapi.opensosen.cn/v1',com:'https://newapi.opensosen.com/v1'});
const isBuiltin=identity=>identity?.provider==='opensosen'&&Object.values(BASES).includes(identity.baseUrl);
const invalid=()=>Object.assign(new Error('访问线路或请求地址无效。'),{code:'TRANSPORT_ROUTE_INVALID',statusCode:400,connectionError:true});
function snapshot(value){
 if(value==null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['route','revision'].includes(key))||!Object.hasOwn(BASES,value.route)||!Number.isSafeInteger(value.revision)||value.revision<1)throw invalid();
 return {route:value.route,revision:value.revision};
}
function managedPath(url,operation){
 if(operation==='models')return url.pathname==='/v1/models'&&!url.search;
 if(operation==='submit')return ['/v1/images/generations','/v1/images/edits','/v1/videos'].includes(url.pathname)&&!url.search;
 const segment='[^/]+';
 if(operation==='poll')return new RegExp('^/v1/videos/'+segment+'$').test(url.pathname)&&!url.search;
 if(operation==='download')return new RegExp('^/v1/videos/'+segment+'/content$').test(url.pathname)&&!url.search;
 return false;
}
function resolveRequest(identity,request,operation,selected){
 if(!isBuiltin(identity))return {...request,transportRoute:null};
 const route=snapshot(selected);if(!route)return {...request,transportRoute:null};
 const url=new URL(request.url),base=new URL(identity.baseUrl);
 if(url.href!==request.url||url.origin!==base.origin||url.username||url.password||url.hash||/[\\\s]/u.test(request.url)||!managedPath(url,operation))throw invalid();
 const method=String(request.method||'GET').toUpperCase();
 if(method!==(operation==='submit'?'POST':'GET'))throw invalid();
 const target=new URL(BASES[route.route]);target.pathname=url.pathname;target.search=url.search;
 return {...request,url:target.href,transportRoute:route};
}
function diagnostic(request){return request.transportRoute?{route:request.transportRoute.route,routeRevision:request.transportRoute.revision,targetHost:new URL(request.url).hostname}:{};}
module.exports={BASES,isBuiltin,snapshot,managedPath,resolveRequest,diagnostic};
