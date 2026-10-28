const {test,before,after}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {createTestDb}=require('./helpers/test-db');const {createApp}=require('../server');const {authorizeWidget}=require('../lib/request-security');const {createLocalChatHandler}=require('../lib/local-chat');
let pg,db,servers=[],urls=[],store;const owner=randomUUID(),admin=randomUUID(),secret='parity-test-secret-'.repeat(4);let oldEmails,oldSecret;
before(async()=>{
 oldEmails=process.env.ADMIN_EMAILS;oldSecret=process.env.WIDGET_SESSION_SECRET;process.env.ADMIN_EMAILS='root@example.com';process.env.WIDGET_SESSION_SECRET=secret;
 ({pg,db}=await createTestDb({security:true}));await pg.query('insert into auth.users(id) values($1),($2)',[owner,admin]);
 store=(await pg.query("insert into public.cc_stores(owner_id,domain,status,access_start,access_until,domain_verified_at,quota_override) values($1,'parity.example.com','active',now()-interval '1 hour',now()+interval '1 day',now(),10) returning *",[owner])).rows[0];
 db.auth={getUser:async token=>({data:{user:token==='admin'?{id:admin,email:'root@example.com'}:token==='owner'?{id:owner,email:'merchant@example.com'}:null},error:null}),admin:{getUserById:async id=>({data:{user:{id,email:'merchant@example.com',user_metadata:{}}},error:null}),updateUserById:async(id,patch)=>({data:{user:{id,...patch}},error:null})}};
 const vercelEntry=require('../api/admin/[...path]');assert.equal(vercelEntry.createApp,createApp);
 for(const factory of [createApp,vercelEntry.createApp]){
  const app=factory({db,hasApiKey:true,generateAI:async(req,res)=>res.json({answer:'Synthetic verified answer'})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});servers.push(server);urls.push('http://127.0.0.1:'+server.address().port);
 }
});
after(async()=>{await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));await pg?.close();if(oldEmails===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=oldEmails;if(oldSecret===undefined)delete process.env.WIDGET_SESSION_SECRET;else process.env.WIDGET_SESSION_SECRET=oldSecret;});
const post=(body,token)=>({method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
for(const index of [0,1])test((index?'Vercel entry':'local entry')+' retains admin auth/self-protection and applies protected pause',async()=>{
 const base=urls[index];
 assert.equal((await fetch(base+'/api/admin/overview')).status,401);
 assert.equal((await fetch(base+'/api/admin/overview',{headers:{Authorization:'Bearer owner'}})).status,403);
 const self=await fetch(base+'/api/admin/users/'+admin+'/pause',post({pause:true},'admin'));assert.equal(self.status,400);
 const paused=await fetch(base+'/api/admin/users/'+owner+'/pause',post({pause:true},'admin'));assert.equal(paused.status,200);
 assert.equal((await pg.query('select status from public.cc_stores where id=$1',[store.id])).rows[0].status,'paused');
 assert.equal((await fetch(base+'/api/admin/users/'+owner+'/pause',post({pause:false},'admin'))).status,200);
 assert.equal((await fetch(base+'/api/health')).status,200);
});
test('local and Vercel entry use same session, quota and request ID across HTTP',async()=>{
 const origin='https://'+store.domain;
 const minted=await fetch(urls[0]+'/api/widget-session',{...post({domain:store.domain}),headers:{'Content-Type':'application/json',Origin:origin}});assert.equal(minted.status,200);const token=(await minted.json()).widget_session;
 const body={request_id:randomUUID(),domain:store.domain,question:'Known facts?',productContext:{title:'Test'}};
 const send=url=>fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Authorization:'Widget '+token},body:JSON.stringify(body)}).then(r=>r.json());
 const a=await send(urls[0]),b=await send(urls[1]);assert.equal(a.usageRecorded,true);assert.deepEqual(a,b);
 assert.equal((await pg.query('select count(*)::int n from public.questions where cc_request_id=$1',[body.request_id])).rows[0].n,1);
});
test('malformed/large JSON and private source paths are blocked consistently',async()=>{
 for(const base of urls){
  assert.equal((await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'})).status,400);
  assert.equal((await fetch(base+'/api/chat',post({question:'x'.repeat(34000)}))).status,413);
  for(const path of ['/lib/request-security.js','/%6cib/request-security.js','/docs/stage-2-entitlements.md','/server.js'])assert.equal((await fetch(base+path)).status,404);
  assert.equal((await fetch(base+'/api/webhook/cancellation',post({store_domain:store.domain}))).status,401);
  assert.equal((await fetch(base+'/api/live-sync',post({domain:store.domain,theme_preset:'classic'}))).status,401);
 }
});
test('preview sync checks ownership and does not accept paid entitlement as a setting',async()=>{
 const base=urls[0];assert.equal((await fetch(base+'/api/live-sync',post({domain:store.domain,plan:'business'},'owner'))).status,400);
 assert.equal((await fetch(base+'/api/live-sync',post({domain:'foreign.example.com',theme_preset:'classic'},'owner'))).status,403);
 assert.equal((await fetch(base+'/api/live-sync',post({domain:store.domain,theme_preset:'classic'},'owner'))).status,200);
});
test('proxy forwards Origin and Authorization for chat and session without local recording',async()=>{
 const req={headers:{origin:'https://parity.example.com',authorization:'Widget signed-token'},body:{request_id:randomUUID()}};
 for(const endpoint of ['chat','widget-session']){
  let captured;const h=createLocalChatHandler(()=>assert.fail('local writer must not run'),{hasApiKey:false,endpoint,fetch:async(url,init)=>{captured={url,init};return {ok:true,status:200,json:async()=>endpoint==='chat'?{requestId:req.body.request_id,usageRecorded:true}:{widget_session:'new-session'}};}});
  const res={status(){return this;},json(){}};await h(req,res);
  assert.equal(captured.init.headers.Origin,req.headers.origin);assert.equal(captured.init.headers.Authorization,req.headers.authorization);assert.ok(captured.url.endsWith('/'+endpoint));
 }
});
