const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createTestDb}=require('./helpers/test-db');
const {createAccountHandler}=require('../lib/store-access');
const {parseHTML}=require('linkedom');
const flow=require('../auth-flow');
const {mountOnboarding}=require('../onboarding-ui');
let pg,db,handler;const owner=randomUUID(),other=randomUUID(),limited=randomUUID();
before(async()=>{
 ({pg,db}=await createTestDb({security:true}));await pg.query('insert into auth.users(id) values($1),($2),($3)',[owner,other,limited]);
 db.auth={getUser:async token=>({data:{user:token==='invalid'?null:{id:token==='other'?other:token==='limited'?limited:owner,email_confirmed_at:token==='unconfirmed'?null:'2026-10-01',user_metadata:{plan:'business',store_domain:'victim.test'}}},error:null})};
 handler=createAccountHandler({db});
});
after(async()=>pg?.close());
async function call(method,body={},token='owner',query={}){const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;return this;}};await handler({method,body,query,headers:token?{authorization:'Bearer '+token}:{}},res);return res;}
test('new confirmed identity creates an inactive store; metadata cannot grant access',async()=>{
 const r=await call('POST',{store_domain:' NEW-SHOP.example '});assert.equal(r.code,201);
 const s=(await pg.query('select * from public.cc_stores where id=$1',[r.body.store.id])).rows[0];
 assert.equal(s.domain,'new-shop.example');assert.equal(s.owner_id,owner);assert.equal(s.status,'inactive');assert.equal(s.plan,'starter');assert.equal(s.domain_verified_at,null);assert.equal(s.quota_override,null);assert.equal(s.billing_source,'manual');
 const snap=await db.rpc('get_cc_store_snapshot',{p_store_id:s.id});assert.equal(snap.data.query_count,0);assert.ok(new Date(s.access_until)<=new Date());
});
test('repeated/concurrent store creation preserves identity; foreign domain is not claimed',async()=>{
 const results=await Promise.all([call('POST',{store_domain:'concurrent.example'}),call('POST',{store_domain:'concurrent.example'})]);
 assert.deepEqual(results.map(r=>r.code).sort(),[200,201]);assert.equal(results[0].body.store.id,results[1].body.store.id);
 assert.equal((await call('POST',{store_domain:'concurrent.example'},'other')).code,409);
 assert.equal((await pg.query("select count(*)::int as n from public.cc_stores where domain='concurrent.example'")).rows[0].n,1);
});
test('auth, email confirmation, malformed domain, paid injection and invalid store ID fail closed',async()=>{
 assert.equal((await call('POST',{store_domain:'x.example'},null)).code,401);
 assert.equal((await call('POST',{store_domain:'x.example'},'invalid')).code,401);
 assert.equal((await call('POST',{store_domain:'x.example'},'unconfirmed')).code,403);
 for(const store_domain of ['mystore.com','http://shop.example/path','localhost','127.0.0.1','bad..example','-shop.example','a'.repeat(64)+'.example'])assert.equal((await call('POST',{store_domain})).code,400);
 for(const injected of ['owner_id','plan','status','quota_override','domain_verified_at'])assert.equal((await call('POST',{store_domain:'x.example',[injected]:'fake'})).code,400);
 assert.equal((await call('GET',{},'owner',{store_id:'fake'})).code,400);
});
test('store list and selected snapshot enforce ownership',async()=>{
 const list=await call('GET',{},'other',{list:'1'});assert.equal(list.code,200);assert.equal(list.body.stores.length,0);
 const mine=await call('GET',{},'owner',{list:'1'});assert.equal(mine.body.stores.length,2);
 assert.equal((await call('GET',{},'other',{store_id:mine.body.stores[0].id})).code,404);
});
test('onboarding creation is rate limited by server identity',async()=>{
 for(let i=0;i<10;i++)assert.equal((await call('POST',{store_domain:'limited.example'},'limited')).code,i===0?201:200);
 assert.equal((await call('POST',{store_domain:'more.example'},'limited')).code,429);
});
test('OAuth callback verifies session, strips URL secrets, and uses fixed local redirect',async()=>{
 const visits=[],clean=[];
 await flow.finishCallback({auth:{getSession:async()=>({data:{session:{}}}),getUser:async()=>({data:{user:{id:owner}}})},location:{href:'https://preview.example/auth-callback.html?code=secret&next=https://evil.example',replace:p=>visits.push(p)},history:{replaceState:(_a,_b,p)=>clean.push(p)}});
 assert.deepEqual(visits,['onboarding.html']);assert.deepEqual(clean,['/auth-callback.html']);assert.equal(flow.callbackUrl('https://preview.example'),'https://preview.example/auth-callback.html');assert.equal(flow.clientOptions.auth.flowType,'pkce');
});
test('denied callback or invalid session stays on error page with no external error echo',async()=>{
 const visits=[],clean=[];
 await assert.rejects(()=>flow.finishCallback({auth:{getSession:async()=>({data:{session:{}}})},location:{href:'https://preview.example/auth-callback.html?error=access_denied&error_description=secret',replace:p=>visits.push(p)},history:{replaceState:(_a,_b,p)=>clean.push(p)}}),/start again/);
 assert.equal(visits.length,0);assert.equal(clean.length,1);
});
test('onboarding UI lists external names as text and remembers store per user',async()=>{
 const {document}=parseHTML('<html><body><p id="status"></p><div id="stores"></div><form id="store-form"><input id="domain"><button id="create-store"></button></form></body></html>');
 const values=new Map(),visits=[];const malicious='<img src=x onerror=alert(1)>';
 const ui=mountOnboarding({document,auth:{getSession:async()=>({data:{session:{}}})},storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},location:{search:'?manage=1',replace:p=>visits.push(p)},flow:{...flow,onboardingRequest:async()=>({result:{stores:[{id:'safe-id',domain:malicious,status:'inactive'}]},userId:owner})}});
 await ui.ready;assert.equal(document.querySelectorAll('img').length,0);assert.match(document.getElementById('stores').textContent,/<img/);
 document.querySelector('#stores button').click();assert.equal(values.get(flow.storeKey(owner)),'safe-id');assert.deepEqual(visits,['dashboard.html']);
});
test('callback with lost/expired session is cleaned and cannot enter onboarding',async()=>{
 let clean=false,redirect=false;
 await assert.rejects(()=>flow.finishCallback({auth:{getSession:async()=>({data:{session:null},error:new Error('provider secret')})},location:{href:'https://app.example/auth-callback.html?code=secret#access_token=secret',replace:()=>{redirect=true;}},history:{replaceState:()=>{clean=true;}}}),/Sign-in could not be completed/);
 assert.equal(clean,true);assert.equal(redirect,false);
});
test('browser request helper -> Local HTTP account route -> DB owned store, with no paid access',async()=>{
 const {createApp}=require('../server');const app=createApp({db});const server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 try{
  const auth={getSession:async()=>({data:{session:{access_token:'other',user:{id:other}}}})};
  const result=await flow.onboardingRequest({auth,fetch,base:'http://127.0.0.1:'+server.address().port,body:{store_domain:'http-onboarding.example'}});
  assert.equal(result.userId,other);assert.equal(result.result.store.status,'inactive');
  const rows=(await pg.query('select owner_id,plan,domain_verified_at from public.cc_stores where id=$1',[result.result.store.id])).rows;
  assert.equal(rows[0].owner_id,other);assert.equal(rows[0].plan,'starter');assert.equal(rows[0].domain_verified_at,null);
  const list=await flow.onboardingRequest({auth,fetch,base:'http://127.0.0.1:'+server.address().port});assert.equal(list.result.stores.length,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('returning owner opens the only server-listed store without submitting a domain',async()=>{
 const {document}=parseHTML('<form id="store-form"><input id="domain"><button id="create-store"></button></form><div id="stores"></div><p id="status"></p>');
 const values=new Map(),visits=[];
 const ui=mountOnboarding({document,auth:{getSession:async()=>({data:{session:{}}})},
   storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
   location:{replace:p=>visits.push(p)},flow:{...flow,onboardingRequest:async()=>({result:{stores:[{id:'owned'}]},userId:owner})}});
 await ui.ready;
 assert.deepEqual(visits,['dashboard.html']);
 assert.equal(values.get(flow.storeKey(owner)),'owned');
});
