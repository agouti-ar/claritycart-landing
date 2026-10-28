const {test,before,after}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {createTestDb}=require('./helpers/test-db');const {createUsageHandler}=require('../lib/usage-handler');
const {createWidgetSessionHandler,authorizeWidget,signSession,verifySession,clientIp}=require('../lib/request-security');
const {createDomainVerificationHandler}=require('../lib/domain-verification');
let pg,db,seq=0;const owner=randomUUID(),other=randomUUID(),secret='test-only-secret-'.repeat(4);let previous;
before(async()=>{previous=process.env.WIDGET_SESSION_SECRET;process.env.WIDGET_SESSION_SECRET=secret;({pg,db}=await createTestDb({security:true,freezeRateClock:true}));await pg.query('insert into auth.users(id) values($1),($2)',[owner,other]);
 db.auth={getUser:async token=>({data:{user:token==='owner'?{id:owner,email:'merchant@example.com'}:token==='other'?{id:other,email:'other@example.com'}:token==='admin'?{id:other,email:'darksteel180@gmail.com'}:null},error:null})};});
after(async()=>{if(previous===undefined)delete process.env.WIDGET_SESSION_SECRET;else process.env.WIDGET_SESSION_SECRET=previous;await pg?.close();});
async function seed(verified=true){seq++;const r=await pg.query("insert into public.cc_stores(owner_id,domain,status,access_start,access_until,domain_verified_at) values($1,$2,'active',now()-interval '1 hour',now()+interval '1 day',$3) returning *",[owner,'store'+seq+'.example.com',verified?new Date():null]);return {...r.rows[0],ip:'198.51.100.'+seq};}
function req(s,body={},headers={}){return {method:'POST',headers:{origin:'https://'+s.domain,...headers},socket:{remoteAddress:s.ip},body:{domain:s.domain,...body}};}
async function run(h,request){const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(b){this.body=b;return this;},end(){return this;}};await h(request,res);return res;}
async function session(s,headers={}){return run(createWidgetSessionHandler({db,secret}),req(s,{},headers));}
const success=async(req,res)=>res.json({answer:'Known facts'});
function chat(s,token,extra={}){return req(s,{request_id:randomUUID(),question:'Known facts?',productContext:{title:'Test'},...extra},{authorization:'Widget '+token});}

test('verified storefront session -> bound request -> repeat -> exactly one usage event',async()=>{
 const s=await seed();const minted=await session(s);assert.equal(minted.code,200);assert.equal(minted.body.developer,false);
 let calls=0;const h=createUsageHandler(async(req,res)=>{calls++;return success(req,res);},{db});const request=chat(s,minted.body.widget_session);
 assert.equal((await run(h,request)).body.usageRecorded,true);assert.equal((await run(h,request)).body.usageRecorded,true);assert.equal(calls,1);
 assert.equal((await pg.query('select count(*)::int n from public.questions where cc_store_id=$1',[s.id])).rows[0].n,1);
});
test('missing/forged token, foreign store, foreign origin and direct RPC cannot bypass access',async()=>{
 const s=await seed(),foreign=await seed();const token=(await session(s)).body.widget_session;let generated=0;const h=createUsageHandler(async()=>{generated++;},{db});
 assert.equal((await run(h,chat(s,'missing'))).code,401);
 assert.equal((await run(h,chat(s,token+'x'))).code,401);
 assert.equal((await run(h,chat(foreign,token))).code,403);
 const bad=chat(s,token);bad.headers.origin='https://evil.example';assert.equal((await run(h,bad)).code,403);assert.equal(generated,0);
 await pg.exec('set role anon');try{await assert.rejects(pg.query('select public.claim_verified_chat_request($1,$2,$3,$4,$5,$6)',[randomUUID(),s.domain,'x',randomUUID(),s.id,1]),/permission denied/);}finally{await pg.exec('reset role');}
});
test('expired and modified signed session are rejected',()=>{
 const now=Date.now(),payload={v:1,sid:randomUUID(),origin:'https://example.com',epoch:1,kind:'storefront',exp:Math.floor(now/1000)-1};assert.throws(()=>verifySession(signSession(payload,secret),secret,now),/EXPIRED/);
 payload.exp=Math.floor(now/1000)+300;const token=signSession(payload,secret);const forged=Buffer.from(JSON.stringify({...payload,developer:true})).toString('base64url')+'.'+token.split('.')[1];assert.throws(()=>verifySession(forged,secret),/INVALID/);
});
test('unverified storefront is denied; preview requires owner or ADMIN_EMAILS identity',async()=>{
 const s=await seed(false);assert.equal((await session(s)).code,403);
 const origin='http://127.0.0.1:5500';assert.equal((await session(s,{origin,authorization:'Bearer other'})).code,403);
 const preview=await session(s,{origin,authorization:'Bearer owner'});assert.equal(preview.code,200);assert.equal(preview.body.developer,false);
 const admin=await session(s,{origin,authorization:'Bearer admin'});assert.equal(admin.code,200);assert.equal(admin.body.developer,true);
 const h=createUsageHandler(success,{db});const r=chat(s,preview.body.widget_session);r.headers.origin=origin;assert.equal((await run(h,r)).body.usageRecorded,true);
});
test('DNS verification uses server-owned challenge and refuses another account',async()=>{
 const s=await seed(false),record='claritycart='+s.domain_verification_token;
 const h=createDomainVerificationHandler({db,resolveTxt:async name=>{assert.equal(name,'_claritycart-verification.'+s.domain);return [[record]];}});
 const request={method:'POST',headers:{authorization:'Bearer owner'},query:{store_id:s.id}};
 assert.equal((await run(h,{...request,headers:{authorization:'Bearer other'}})).code,404);
 assert.equal((await run(h,request)).body.verified,true);assert.equal((await session(s)).code,200);
});
test('concurrent domain change invalidates verification and old widget sessions',async()=>{
 const s=await seed();const token=(await session(s)).body.widget_session;
 const h=createDomainVerificationHandler({db,resolveTxt:async()=>{await pg.query('update public.cc_stores set domain=$2 where id=$1',[s.id,'changed'+seq+'.example.com']);return [['claritycart='+s.domain_verification_token]];}});
 const result=await run(h,{method:'POST',headers:{authorization:'Bearer owner'},query:{store_id:s.id}});assert.equal(result.body.error,'DOMAIN_CHANGED');
 assert.equal((await run(createUsageHandler(success,{db}),chat(s,token))).code,403);
 const current=(await pg.query('select * from public.cc_stores where id=$1',[s.id])).rows[0];assert.equal(current.domain_verified_at,null);assert.equal(current.widget_epoch,2);assert.notEqual(current.domain_verification_token,s.domain_verification_token);
});
test('store binding is checked again inside reservation transaction',async()=>{
 const s=await seed();const result=await db.rpc('claim_verified_chat_request',{p_request_id:randomUUID(),p_domain:s.domain,p_fingerprint:'x',p_owner:randomUUID(),p_store_id:s.id,p_widget_epoch:0});assert.equal(result.data.state,'denied');
});
test('large/malformed inputs are rejected before authorization or AI',async()=>{
 const s=await seed();let authorized=0;const h=createUsageHandler(success,{db,authorize:async()=>{authorized++;return {};}});
 for(const extra of [{question:'x'.repeat(2001)},{productContext:{description:'x'.repeat(16001)}},{productContext:'bad'},{temperature:4}])assert.equal((await run(h,chat(s,'x',extra))).code,400);
 assert.equal((await run(h,chat(s,'x',{unused:'x'.repeat(33000)}))).code,413);assert.equal(authorized,0);
});
test('IP rate limit is persisted and does not trust caller X-Forwarded-For',async()=>{
 const s=await seed();const token=(await session(s)).body.widget_session;
 for(let i=0;i<30;i++){const r=chat(s,token);r.headers['x-forwarded-for']='203.0.113.'+i;await authorizeWidget(r,db);}
 await assert.rejects(authorizeWidget(chat(s,token),db),error=>error.status===429);
 const rows=(await pg.query('select bucket from cc_private.rate_limits')).rows;assert.ok(rows.length>0);assert.ok(rows.every(r=>/^[a-f0-9]{64}$/.test(r.bucket)));
 assert.equal(clientIp({headers:{'x-forwarded-for':'1.2.3.4'},socket:{remoteAddress:'127.0.0.1'}},false),'127.0.0.1');
 assert.equal(clientIp({headers:{'x-vercel-forwarded-for':'203.0.113.2'},socket:{remoteAddress:'127.0.0.1'}},true),'203.0.113.2');
});
test('old broad policies and column grants cannot expose other stores or anon questions',async()=>{
 const a=await seed();const b=(await pg.query("insert into public.cc_stores(owner_id,domain) values($1,'other.example.com') returning *",[other])).rows[0];
 await pg.query("insert into public.questions(store_domain,question_text,cc_store_id) values($1,'mine',$2),($3,'foreign',$4)",[a.domain,a.id,b.domain,b.id]);
 await pg.exec('set role anon');try{await assert.rejects(pg.query('select id from public.questions'),/permission denied/);}finally{await pg.exec('reset role');}
 await pg.exec('set role authenticated');await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 try{const rows=(await pg.query('select question_text from public.questions')).rows;assert.ok(rows.some(r=>r.question_text==='mine'));assert.ok(!rows.some(r=>r.question_text==='foreign'));await assert.rejects(pg.query("update public.questions set question_text='tampered'"),/permission denied/);}finally{await pg.exec('reset role');}
});

test('unmapped history is not readable or counted by claiming its domain',async()=>{
 const s=await seed(false);
 await pg.query("insert into public.questions(store_domain,question_text) values($1,'unmapped-private-history')",[s.domain]);
 const snap=await db.rpc('get_cc_store_snapshot',{p_store_id:s.id});assert.equal(snap.data.query_count,0);
 await pg.exec('set role authenticated');await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 await pg.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({user_metadata:{store_domain:s.domain}})]);
 try{assert.equal((await pg.query("select count(*)::int n from public.questions where question_text='unmapped-private-history'")).rows[0].n,0);}finally{await pg.exec('reset role');}
});
test('store rate limit applies across different client IPs',async()=>{
 const s=await seed();const token=(await session(s)).body.widget_session;
 for(let i=1;i<=120;i++){const r=chat(s,token);r.socket.remoteAddress='203.0.113.'+i;await authorizeWidget(r,db);}
 const r=chat(s,token);r.socket.remoteAddress='203.0.113.200';await assert.rejects(authorizeWidget(r,db),error=>error.status===429);
});
test('read-only preflight executes and does not include question text',async()=>{
 const results=await pg.exec(require('node:fs').readFileSync('scripts/supabase-readonly-preflight.sql','utf8'));
 const snapshot=results.find(r=>r.rows?.[0]?.compatibility_snapshot)?.rows[0].compatibility_snapshot;
 assert.ok(snapshot);assert.equal(snapshot.questions_columns.find(c=>c.name==='id').identity_generation,'ALWAYS');
 assert.ok(!JSON.stringify(snapshot).includes('unmapped-private-history'));
});
