const dns=require('node:dns').promises;const net=require('node:net');const http=require('node:http');const https=require('node:https');
class SiteError extends Error{constructor(code){super(code);this.code=code;}}
const blocked=new net.BlockList();
for(const [ip,bits]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],['168.63.129.16',32]])blocked.addSubnet(ip,bits,'ipv4');
const v6global=new net.BlockList();v6global.addSubnet('2000::',3,'ipv6');
for(const[ip,bits]of [['2001::',23],['2001:2::',48],['2001:10::',28],['2001:20::',28],['2001:db8::',32],['2002::',16],['3fff::',20],['3ffe::',16]])blocked.addSubnet(ip,bits,'ipv6');
function isPublicIP(ip){const family=net.isIP(ip);if(family===4)return !blocked.check(ip,'ipv4');if(family!==6)return false;
 // IPv4-mapped addresses are rejected, not decoded into an alternate bypass path.
 return v6global.check(ip,'ipv6')&&!blocked.check(ip,'ipv6');
}
function target(input){
 if(typeof input!=='string'||input.length>1024||/[\s\x00-\x1f\\]/.test(input))throw new SiteError('INVALID_TARGET');
 let u;try{u=new URL(input.includes('://')?input:'https://'+input);}catch{throw new SiteError('INVALID_TARGET');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||u.hash)throw new SiteError('UNSAFE_TARGET');
 const host=u.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
 if(net.isIP(host)){if(!isPublicIP(host))throw new SiteError('UNSAFE_TARGET');}
 else if(!host.includes('.')||host.length>253||host.split('.').some(x=>!x||x.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x))||/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host))throw new SiteError('UNSAFE_TARGET');
 u.hostname=net.isIP(host)===6?'['+host+']':host;return u;
}
function bounded(promise,signal){if(signal.aborted)return Promise.reject(new SiteError('TIMEOUT'));return new Promise((resolve,reject)=>{
 const abort=()=>{cleanup();reject(new SiteError('TIMEOUT'));};const cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});promise.then(v=>{cleanup();resolve(v);},e=>{cleanup();reject(e);});
});}
async function resolvePublic(url,lookup=dns.lookup,signal){const host=url.hostname.replace(/^\[|\]$/g,'');
 const records=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await bounded(Promise.resolve().then(()=>lookup(host,{all:true,verbatim:true})),signal);
 if(!Array.isArray(records)||!records.length||records.some(r=>!isPublicIP(r.address)||net.isIP(r.address)!==r.family))throw new SiteError('UNSAFE_DNS');return records[0];
}
function pinnedRequest(url,pin,{signal,maxBytes,budget},requestFactory){return new Promise((resolve,reject)=>{
 let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;error?reject(error):resolve(value);};
 const request=requestFactory||((u,opts,callback)=>(u.protocol==='https:'?https:http).request(u,opts,callback));
 const req=request(url,{method:'GET',agent:false,autoSelectFamily:false,family:pin.family,signal,maxHeaderSize:16384,
  lookup:(_host,opts,callback)=>{if(typeof opts==='function'){callback=opts;opts={};}callback(null,opts?.all?[pin]:pin.address,pin.family);},
  headers:{'User-Agent':'ClarityCart-ColorDetector/2.0','Accept':'text/html,text/css,application/manifest+json,application/json,image/svg+xml','Accept-Encoding':'identity'}
 },response=>{
  const peer=response.socket?.remoteAddress;
  const canonical=ip=>net.isIP(ip)===6?new URL('http://['+ip+']/').hostname:ip;
  if(!isPublicIP(peer)||canonical(peer)!==canonical(pin.address)){response.destroy();finish(new SiteError('PIN_MISMATCH'));return;}
  const status=response.statusCode||0,headers=response.headers;
  if([301,302,303,307,308].includes(status)){response.destroy();finish(null,{status,headers,text:''});return;}
  if(status<200||status>=300){response.destroy();finish(new SiteError('UPSTREAM_STATUS'));return;}
  if(headers['content-encoding']&&headers['content-encoding']!=='identity'){response.destroy();finish(new SiteError('UNSUPPORTED_ENCODING'));return;}
  if(Number(headers['content-length'])>maxBytes){response.destroy();finish(new SiteError('RESPONSE_TOO_LARGE'));return;}
  const chunks=[];let size=0;
  response.on('data',chunk=>{size+=chunk.length;budget.bytes+=chunk.length;if(size>maxBytes||budget.bytes>300000){response.destroy();req.destroy();finish(new SiteError('RESPONSE_TOO_LARGE'));return;}chunks.push(chunk);});
  response.on('end',()=>finish(null,{status,headers,text:Buffer.concat(chunks).toString('utf8')}));response.on('error',error=>finish(error));response.on('aborted',()=>finish(new SiteError('RESPONSE_ABORTED')));
 });
 req.on('error',error=>finish(error));req.end();
});}
function createSiteFetcher(options={}){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),options.timeoutMs||6000);const budget={bytes:0,requests:0};
 async function get(input,types,maxBytes){
  let url=target(input);
  for(let redirects=0;redirects<=3;redirects++){
   if(controller.signal.aborted)throw new SiteError('TIMEOUT');if(++budget.requests>8)throw new SiteError('REQUEST_LIMIT');
   const pin=await resolvePublic(url,options.lookup,controller.signal);
   const response=await pinnedRequest(url,pin,{signal:controller.signal,maxBytes,budget},options.request);
   if([301,302,303,307,308].includes(response.status)){
    if(!response.headers.location||redirects===3)throw new SiteError('REDIRECT_LIMIT');const next=target(new URL(response.headers.location,url).href);
    if(url.protocol==='https:'&&next.protocol==='http:')throw new SiteError('UNSAFE_REDIRECT');url=next;continue;
   }
   const mime=String(response.headers['content-type']||'').split(';')[0].trim().toLowerCase();if(!types.includes(mime))throw new SiteError('INVALID_CONTENT_TYPE');
   return {...response,url:url.href};
  }
 }
 return {get,close(){clearTimeout(timer);controller.abort();},budget};
}
module.exports={SiteError,isPublicIP,target,resolvePublic,pinnedRequest,createSiteFetcher};
