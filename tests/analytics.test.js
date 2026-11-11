const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createTestDb}=require('./helpers/test-db');
const {createEventsHandler,analyticsIdentity}=require('../lib/events-handler');
const {signSession}=require('../lib/request-security');
const {createUsageHandler}=require('../lib/usage-handler');
let pg,db,handler,store,foreign,oldSecret;const owner=randomUUID(),other=randomUUID(),secret='analytics-test-secret-'.repeat(3);
before(async()=>{
 oldSecret=process.env.WIDGET_SESSION_SECRET;process.env.WIDGET_SESSION_SECRET=secret;
 ({pg,db}=await createTestDb({security:true,analytics:true,freezeRateClock:true,beforeMigrations:async pg=>{for(let i=0;i<20;i++)await pg.query("insert into public.questions(store_domain,question_text) values('legacy.example',$1)",['legacy '+i]);}}));
 await pg.query('insert into auth.users(id) values($1),($2)',[owner,other]);
 store=(await pg.query("insert into public.cc_stores(owner_id,domain,domain_verified_at,status,access_until) values($1,'analytics.example',now(),'active',now()+interval '30 days') returning *",[owner])).rows[0];
 foreign=(await pg.query("insert into public.cc_stores(owner_id,domain,domain_verified_at) values($1,'other.example',now()) returning *",[other])).rows[0];
 db.auth={getUser:async t=>({data:{user:t==='owner'?{id:owner}:t==='other'?{id:other}:null},error:null})};
 handler=createEventsHandler({db,secret,vercel:false});
});
after(async()=>{process.env.WIDGET_SESSION_SECRET=oldSecret;await pg?.close();});
function token(s=store,kind='storefront'){return signSession({v:1,sid:s.id,origin:'https://'+s.domain,epoch:s.widget_epoch,kind,uid:owner,exp:Math.floor(Date.now()/1000)+300},secret);}
function req(body={},extra={}){return {method:'POST',body:{domain:store.domain,visitor_id:randomUUID(),session_id:randomUUID(),events:[{event_id:randomUUID(),type:'product_view',product_path:'/products/lamp'}],...body},headers:{origin:'https://'+store.domain,authorization:'Widget '+token()},socket:{remoteAddress:'127.0.0.1'},...extra};}
async function run(h,req){const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;},end(){return this;}};await h(req,res);return res;}
async function metrics(s=store,id=owner){return (await db.rpc('get_cc_analytics',{p_store_id:s.id,p_owner_id:id})).data;}
test('migration preserves 20 legacy questions unmapped and private RLS/service-only RPC',async()=>{
 assert.equal((await pg.query('select count(*)::int n from public.questions where cc_store_id is null')).rows[0].n,20);
 assert.equal((await metrics()).questions_answered,0);
 for(const role of ['anon','authenticated'])for(const name of ['ingest_cc_events(uuid,integer,text,uuid,jsonb)','bind_cc_chat_analytics(uuid,uuid,uuid,integer,boolean,text,uuid)','get_cc_analytics(uuid,uuid)'])assert.equal((await pg.query('select has_function_privilege($1,$2,\'execute\') ok',[role,'public.'+name])).rows[0].ok,false);
 assert.equal((await pg.query("select bool_and(relrowsecurity) ok from pg_class where oid in ('cc_private.analytics_events'::regclass,'cc_private.analytics_sessions'::regclass)")).rows[0].ok,true);
});
test('verified event -> session/visitor; exact retry and 10 concurrent deliveries insert once',async()=>{
 const r=req();const results=await Promise.all(Array.from({length:10},()=>run(handler,r)));assert.equal(results.reduce((n,r)=>n+(r.body.accepted||0),0),1);
 const m=await metrics();assert.equal(m.product_views,1);assert.equal(m.sessions,1);assert.equal(m.visitors,1);
 const row=(await pg.query('select * from cc_private.analytics_events')).rows[0];assert.notEqual(row.visitor_hash,r.body.visitor_id);assert.equal(row.product_ref,analyticsIdentity('/products/lamp',store.id,secret));assert.equal(JSON.stringify(row).includes('/products/lamp'),false);
});
test('changed event ID payload is rejected atomically; session cannot change visitor',async()=>{
 const r=req();await run(handler,r);const before=(await metrics()).product_views;
 const changed=JSON.parse(JSON.stringify(r));changed.body.events=[{event_id:randomUUID(),type:'product_view',product_path:'/new'}, {...r.body.events[0],product_path:'/changed'}];
 assert.equal((await run(handler,changed)).code,409);assert.equal((await metrics()).product_views,before);
 const otherVisitor={...r,body:{...r.body,visitor_id:randomUUID(),events:[{...r.body.events[0],event_id:randomUUID()}]}};
 assert.equal((await run(handler,otherVisitor)).body.error,'SESSION_CONFLICT');
});
test('session start is unique per session; same visitor can have multiple sessions; cart is a real explicit event',async()=>{
 const visitor=randomUUID(),session=randomUUID();const before=await metrics();
 for(let i=0;i<2;i++)assert.equal((await run(handler,req({visitor_id:visitor,session_id:session,events:[{event_id:randomUUID(),type:'session_start'}]}))).code,200);
 await run(handler,req({visitor_id:visitor,events:[{event_id:randomUUID(),type:'cart_add',source:'merchant_confirmed',product_path:'/products/lamp'}]}));
 const m=await metrics();assert.equal(m.sessions,before.sessions+2);assert.equal(m.visitors,before.visitors+1);assert.equal(m.cart_additions,before.cart_additions+1);assert.equal(m.revenue,null);
});
test('missing/forged token, wrong origin, foreign store and revoked epoch cannot write',async()=>{
 assert.equal((await run(handler,req({}, {headers:{origin:'https://'+store.domain}}))).code,401);
 const r=req();assert.equal((await run(handler,{...r,headers:{...r.headers,origin:'https://evil.example'}})).code,403);
 assert.equal((await run(handler,{...r,body:{...r.body,domain:foreign.domain}})).code,403);
 const stale=token();await pg.query('update public.cc_stores set widget_epoch=widget_epoch+1 where id=$1',[store.id]);store.widget_epoch++;
 assert.equal((await run(handler,{...r,headers:{...r.headers,authorization:'Widget '+stale}})).code,403);
});
test('preview events are ignored and owner aggregate endpoint rejects other owners',async()=>{
 const r=req();const before=await metrics();assert.equal((await run(handler,{...r,headers:{...r.headers,authorization:'Widget '+token(store,'preview')}})).body.ignored,true);
 assert.equal((await metrics()).product_views,before.product_views);
 assert.equal((await run(handler,{method:'GET',query:{store_id:store.id},headers:{authorization:'Bearer other'}})).code,404);
 assert.equal((await run(handler,{method:'GET',query:{store_id:store.id},headers:{authorization:'Bearer owner'}})).code,200);
 assert.equal((await metrics(store,other)).error,'STORE_OWNER_MISMATCH');
});
test('oversized/malformed/extra PII fields and unconfirmed cart clicks rejected; IP rate limit enforced',async()=>{
 assert.equal((await run(handler,req({events:Array(21).fill({})}))).code,400);
 assert.equal((await run(handler,req({email:'buyer@example.com'}))).code,400);
 assert.equal((await run(handler,req({events:[{event_id:randomUUID(),type:'cart_add',source:'click',product_path:'/p'}]}))).code,400);
 assert.equal((await run(handler,req({events:[{event_id:randomUUID(),type:'product_view',product_path:'/p?email=pii'}]}))).code,400);
 let limited;for(let i=0;i<61;i++){limited=await run(handler,req({}, {socket:{remoteAddress:'127.0.0.88'}}));if(limited.code===429)break;}assert.equal(limited.code,429);
});
test('server-confirmed answer counts once, preview/error never count, and browser events cannot mint answers',async()=>{
 const visitor=randomUUID(),session=randomUUID();const before=await metrics();
 const chat=createUsageHandler(async(req,res)=>res.json({answer:'Known product facts'}),{db});
 const r=req();r.body={request_id:randomUUID(),domain:store.domain,question:'What material?',productContext:{title:'Lamp'},analytics:{visitor_id:visitor,session_id:session}};
 const a=await run(chat,r);assert.equal(a.body.usageRecorded,true);await run(chat,r);
 const m=await metrics();assert.equal(m.questions_answered,before.questions_answered+1);assert.equal(m.engaged_visitors,before.engaged_visitors+1);assert.equal(m.estimated_time_saved_seconds,m.questions_answered*150);
 const preview={...r,headers:{...r.headers,authorization:'Widget '+token(store,'preview')},body:{...r.body,request_id:randomUUID()}};await run(chat,preview);
 const error=createUsageHandler(async()=>{throw Error('AI unavailable');},{db});await run(error,{...r,body:{...r.body,request_id:randomUUID()}});
 assert.equal((await metrics()).questions_answered,m.questions_answered);
 assert.equal((await pg.query('select count(*)::int n from public.questions where cc_request_id=$1',[r.body.request_id])).rows[0].n,1);
 assert.equal((await run(handler,req({events:[{event_id:randomUUID(),type:'answer',product_path:'/p'}]}))).code,400);
});
test('real Local and shared Vercel alias expose events with the same handler',async()=>{
 const {createApp}=require('../server');const server=createApp({db,eventsOptions:{secret,vercel:false}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(const path of ['/api/events','/api/billing/events']){const response=await fetch('http://127.0.0.1:'+server.address().port+path+'?store_id='+store.id,{headers:{Authorization:'Bearer owner'}});assert.equal(response.status,200);assert.equal((await response.json()).store_id,store.id);}}
 finally{await new Promise(r=>server.close(r));}
});
test('replaying an old accepted event does not refresh session activity',async()=>{
 const r=req();await run(handler,r);await pg.query("update cc_private.analytics_sessions set last_seen=now()-interval '1 day' where store_id=$1 and session_id=$2",[store.id,r.body.session_id]);
 const before=(await pg.query('select last_seen from cc_private.analytics_sessions where store_id=$1 and session_id=$2',[store.id,r.body.session_id])).rows[0].last_seen;
 assert.equal((await run(handler,r)).body.accepted,0);
 assert.equal(new Date((await pg.query('select last_seen from cc_private.analytics_sessions where store_id=$1 and session_id=$2',[store.id,r.body.session_id])).rows[0].last_seen).getTime(),new Date(before).getTime());
});
test('analytics failure never breaks successful AI usage; unknown attribution remains explicitly unclassified',async()=>{
 const failing={...db,rpc(name,args){if(name!=='bind_cc_chat_analytics')return db.rpc(name,args);const p=Promise.resolve({error:{code:'PGRST202'}});p.abortSignal=()=>p;return p;}};
 const h=createUsageHandler(async(req,res)=>res.json({answer:'Known fact'}),{db:failing});const r=req();r.body={request_id:randomUUID(),domain:store.domain,question:'Known?',productContext:{}};
 const before=await metrics();const response=await run(h,r);assert.equal(response.body.usageRecorded,true);assert.equal((await metrics()).unclassified_answers,before.unclassified_answers+1);
 assert.equal((await pg.query('select count(*)::int n from public.questions where cc_request_id=$1',[r.body.request_id])).rows[0].n,1);
});
test('30 day windows exclude older events/answers and daily buckets use server UTC completion',async()=>{
 const before=await metrics();
 await pg.query("insert into public.chat_requests(request_id,store_domain,fingerprint,owner_token,state,http_status,response,created_at,completed_at,store_id,analytics_preview) values($1,$2,'old',$3,'completed',200,'{\"usageRecorded\":true}',now()-interval '31 days',now()-interval '31 days',$4,false)",[randomUUID(),store.domain,randomUUID(),store.id]);
 assert.equal((await metrics()).questions_answered,before.questions_answered);assert.equal((await metrics()).daily_questions.length,7);
 assert.equal((await pg.query("select count(*)::int n from public.questions where cc_store_id is null and question_text like 'legacy %'")).rows[0].n,20);
});
test('Business analytics gating uses stored entitlement, never frontend plan flags',async()=>{
 const get=()=>run(handler,{method:'GET',query:{store_id:store.id},headers:{authorization:'Bearer owner'}});
 const basic=await get();assert.equal(basic.body.advanced_available,false);assert.equal(basic.body.cart_additions,null);
 await pg.query("update public.cc_stores set plan='business' where id=$1",[store.id]);
 const paid=await get();assert.equal(paid.body.advanced_available,true);assert.equal(typeof paid.body.cart_additions,'number');
 await pg.query("update public.cc_stores set status='inactive' where id=$1",[store.id]);assert.equal((await get()).body.advanced_available,false);
 await pg.query("update public.cc_stores set plan='starter',status='active' where id=$1",[store.id]);
});
test('prepared read-only postflight validates all analytics RLS/grants',async()=>{
 const sql=require('node:fs').readFileSync('scripts/analytics-readonly-postflight.sql','utf8');const result=await pg.exec(sql);
 assert.equal(result[0].rows[0].two_tables,true);assert.equal(result[0].rows[0].all_rls_enabled,true);assert.equal(result[0].rows[0].anon_no_direct_access,true);assert.equal(result[0].rows[0].authenticated_no_direct_access,true);
 assert.equal(result[1].rows.length,3);for(const row of result[1].rows)for(const field of ['invoker','service_allowed','anon_denied','authenticated_denied'])assert.equal(row[field],true);
});
