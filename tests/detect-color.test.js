const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const safe=require('../lib/safe-site-fetch');const {detectColor,cssColor,FALLBACK}=require('../lib/detect-color');
function transport(pages,options={}){const calls=[];return {calls,lookup:options.lookup||(async()=>[{address:'93.184.216.34',family:4}]),request:(url,opts,callback)=>{
 calls.push(url.href);const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const p=pages[url.pathname]||pages['/']||{};const response=new PassThrough();response.statusCode=p.status||200;response.headers={'content-type':p.type||'text/html',...p.headers};response.socket={remoteAddress:p.peer||'93.184.216.34'};callback(response);response.end(p.body||'');});return req;
 }};}
test('reject private, loopback, link-local, metadata, nonstandard ports and alternate IP encodings',()=>{
 for(const url of ['localhost','127.0.0.1','127.1','2130706433','0x7f000001','0177.0.0.1','10.0.0.1','172.31.1.1','192.168.1.1','100.64.0.1','169.254.169.254','168.63.129.16','0.0.0.0','[::1]','[::ffff:127.0.0.1]','[fc00::1]','[fe80::1]','[64:ff9b::7f00:1]','[2001:db8::1]','[2002:7f00:1::1]','https://example.com:8443','ftp://example.com','https://a:b@example.com','foo.local','foo.internal','example.com\\@127.0.0.1'])assert.throws(()=>safe.target(url),url);
 for(const url of ['example.com','https://example.com:443','http://example.com:80','8.8.8.8','https://[2606:4700:4700::1111]'])assert.ok(safe.target(url));
});
test('mixed public/private DNS and private redirect cannot reach target',async()=>{
 const mixed=transport({}, {lookup:async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]});await assert.rejects(detectColor('example.com',mixed),/UNSAFE_DNS/);assert.equal(mixed.calls.length,0);
 const redirect=transport({'/':{status:302,headers:{location:'http://169.254.169.254/latest'}}});await assert.rejects(detectColor('example.com',redirect),/UNSAFE_TARGET/);assert.equal(redirect.calls.length,1);
});
test('redirects re-resolve each hop, refuse downgrade/loops, reject mismatched peer',async()=>{
 let resolutions=0;const rebound=transport({'/':{status:302,headers:{location:'/next'}}},{lookup:async()=>[{address:++resolutions===1?'93.184.216.34':'127.0.0.1',family:4}]});await assert.rejects(detectColor('example.com',rebound),/UNSAFE_DNS/);assert.equal(rebound.calls.length,1);
 for(const location of ['http://example.com','/loop']){const t=transport({'/':{status:302,headers:{location}}});await assert.rejects(detectColor('example.com',t),/UNSAFE_REDIRECT|REDIRECT_LIMIT/);assert.ok(t.calls.length<=4);}
 await assert.rejects(detectColor('example.com',transport({'/':{peer:'127.0.0.1'}})),/PIN_MISMATCH/);
});
test('native request receives pinned DNS lookup instead of rebinding lookup',async()=>{
 let n=0;const t=transport({'/':{body:'<meta name="theme-color" content="#123456">'}});const original=t.request;t.request=(url,opts,cb)=>{opts.lookup('example.com',{},(err,address,family)=>{assert.equal(err,null);assert.equal(address,'93.184.216.34');assert.equal(family,4);n++;});return original(url,opts,cb);};
 assert.equal((await detectColor('example.com',t)).color,'#123456');assert.equal(n,1);
});
test('honest explicit hints: meta, root CSS aliases, manifest, linked CSS and simple SVG icon',async()=>{
 const fixtures=[['<meta name="theme-color" content="#aBc">',{},'meta_theme_color','#AABBCC'],['<style>:root{--a:#123456;--brand-color:var(--a)}</style>',{},'css_variable','#123456'],['<link rel="manifest" href="/manifest">',{'/manifest':{type:'application/json',body:'{"theme_color":"#ee4455"}'}},'manifest_theme_color','#EE4455'],['<link rel="stylesheet" href="/style">',{'/style':{type:'text/css',body:':root{--primary-color:#123456}'}},'css_variable','#123456'],['<link rel="icon" href="/icon.svg">',{'/icon.svg':{type:'image/svg+xml',body:'<svg><path fill="#8844ee"/></svg>'}},'svg_icon_fill','#8844EE']];
 for(const[body,extra,source,color]of fixtures)assert.deepEqual(await detectColor('example.com',transport({'/':{body},...extra})),{detected:true,source,color});
});
test('no invented brand from random colors, scripts, comments, circular variables or CSS palette',async()=>{
 for(const body of ['<p style="color:#ff0000">red</p>','<script>const x=`<meta name="theme-color" content="#123456">`</script>','<!-- <meta name="theme-color" content="#123456"> -->','<style>:root{--red-500:#ff0000;--blue-500:#0000ff}</style>','<style>:root{--brand:var(--other);--other:var(--brand)}</style>'])assert.deepEqual(await detectColor('example.com',transport({'/':{body}})),FALLBACK);
 assert.equal(cssColor('.product{--brand-color:#123456}'),null);
});
test('SSRF through referenced CSS or manifest is rejected',async()=>{
 for(const rel of ['stylesheet','manifest'])await assert.rejects(detectColor('example.com',transport({'/':{body:`<link rel="${rel}" href="http://127.0.0.1/secret">`}})),/UNSAFE_TARGET/);
});
test('bounded HTML, content type, compression, DNS timeout and chunked response',async()=>{
 for(const page of [{body:'x'.repeat(180001)},{headers:{'content-length':'200000'}},{type:'application/pdf'},{headers:{'content-encoding':'gzip'}}])await assert.rejects(detectColor('example.com',transport({'/':page})),/RESPONSE_TOO_LARGE|INVALID_CONTENT_TYPE|UNSUPPORTED_ENCODING/);
 await assert.rejects(detectColor('example.com',{timeoutMs:20,lookup:()=>new Promise(()=>{})}),/TIMEOUT/);
});
module.exports={transport};
