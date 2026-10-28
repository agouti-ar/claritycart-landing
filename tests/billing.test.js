const {test,before,after}=require('node:test');const assert=require('node:assert/strict');
const {randomUUID,createHmac}=require('node:crypto');const {createTestDb}=require('./helpers/test-db');
const {createBillingHandlers}=require('../lib/billing-handler');const {verifySignature,paddleClient}=require('../lib/paddle');
const {validatedPatch}=require('../lib/store-access');const {createUsageHandler}=require('../lib/usage-handler');
let pg,db,seq=0,txseq=0,eventseq=0;const owner=randomUUID(),other=randomUUID();
const identities=new Map([['owner',owner],['other',other]]);let legacyFingerprint;
const pid=(p,n)=>p+'_'+String(n).padStart(26,'0');const secret='pdl_ntfset_synthetic_secret';const now=Date.now();
const iso=ms=>new Date(ms).toISOString();const env={PADDLE_ENVIRONMENT:'sandbox',PADDLE_API_KEY:'test-only',PADDLE_WEBHOOK_SECRET:secret,PADDLE_CHECKOUT_URL:'https://merchant.example/pay'};
const catalog={};let priceSeq=1;for(const plan of ['starter','pro','business'])for(const interval of ['month','year'])for(const trial of [false,true]){
 const price=pid('pri',priceSeq++),key=`PADDLE_PRICE_${plan.toUpperCase()}_${interval==='month'?'MONTHLY':'YEARLY'}${trial?'_TRIAL':''}`;env[key]=price;
 catalog[price]={id:price,status:'active',billing_cycle:{interval,frequency:1},trial_period:trial?{interval:'day',frequency:7,requires_payment_method:true}:null,unit_price:{amount:'999',currency_code:'USD'}};
}
const created=[];let calls=[];
const paddle=async(path,options={})=>{calls.push({path,...options});if(path.startsWith('/prices/'))return catalog[path.split('/').pop()];if(path==='/transactions'){const id=pid('txn',++txseq);created.push({id,...options.body});return {id,checkout:{url:'https://merchant.example/pay?_ptxn='+id}};}return {id:path.split('/')[2]};};
let api,webhook;
before(async()=>{({pg,db}=await createTestDb({security:true,billing:true,beforeMigrations:async pg=>{
 await pg.exec("insert into public.questions(store_domain,question_text) select 'legacy.example','synthetic legacy '||n from generate_series(1,20) n");
 legacyFingerprint=(await pg.exec(require('node:fs').readFileSync('scripts/supabase-history-fingerprint.sql','utf8'))).find(r=>r.rows?.[0]?.original_history_fingerprint).rows[0];
 }}));await pg.query('insert into auth.users(id) values($1),($2)',[owner,other]);db.auth={getUser:async t=>({data:{user:identities.has(t)?{id:identities.get(t)}:null},error:null})};({api,webhook}=createBillingHandlers({db,env,paddle,now:()=>now}));});
after(async()=>pg?.close());
async function run(h,req){const res={code:200,setHeader(){},status(c){this.code=c;return this;},json(v){this.body=v;return this;}};await h(req,res);return res;}
const req=(action,body,token='owner')=>({method:action==='status'?'GET':'POST',path:'/api/billing/'+action,body,query:body,headers:token?{authorization:'Bearer '+token}:{}});
async function seed(who=owner){return (await pg.query('insert into public.cc_stores(owner_id,domain) values($1,$2) returning *',[who,'bill'+(++seq)+'.example'])).rows[0];}
async function checkout(s,token='owner'){const r=await run(api,req('checkout',{store_id:s.id,request_id:randomUUID(),plan:'starter',interval:'month'},token));assert.equal(r.code,200,JSON.stringify(r.body));const row=(await pg.query('select * from cc_private.paddle_checkouts where transaction_id=$1',[r.body.transaction_id])).rows[0];return row;}
function sub(c,overrides={}){const start=iso(now-3600000),end=iso(now+6*86400000);return {id:pid('sub',++seq),status:'trialing',customer_id:pid('ctm',1),collection_mode:'automatic',transaction_id:c.transaction_id,custom_data:{claritycart_checkout_id:c.id},items:[{quantity:1,price:{id:c.price_id},trial_dates:{starts_at:start,ends_at:end}}],started_at:start,first_billed_at:null,current_billing_period:{starts_at:start,ends_at:end},updated_at:iso(now+(++eventseq)*1000),scheduled_change:null,...overrides};}
function event(type,data){return {event_id:pid('evt',++eventseq),event_type:type,occurred_at:iso(now+eventseq*1000),data};}
function signed(e){const raw=Buffer.from(JSON.stringify(e));const ts=Math.floor(now/1000);return {method:'POST',body:raw,headers:{'paddle-signature':`ts=${ts};h1=${createHmac('sha256',secret).update(ts+':').update(raw).digest('hex')}`}};}
async function send(type,data){const e=event(type,{...data,updated_at:iso(now+(++eventseq)*1000)});const r=await run(webhook,signed(e));assert.equal(r.code,200,JSON.stringify(r.body));return {e,r};}
async function snapshot(s){const r=await db.rpc('get_cc_store_snapshot',{p_store_id:s.id});assert.equal(r.error,null);return r.data;}
function payment(c,b,overrides={}){return {id:pid('txn',++txseq),subscription_id:b.id,customer_id:b.customer_id,status:'completed',collection_mode:'automatic',custom_data:{claritycart_checkout_id:c.id},items:[{quantity:1,price:{id:b.items[0].price.id}}],billing_period:b.current_billing_period,details:{totals:{total:'999'}},currency_code:'USD',updated_at:iso(now+(++eventseq)*1000),...overrides};}

test('signature verifies exact bytes, rotation and timestamp; rejects tamper, old/future and parsed JSON',()=>{
 const e=event('ignored.event',{}),r=signed(e);assert.doesNotThrow(()=>verifySignature(r.body,r.headers['paddle-signature'],secret,now));
 assert.doesNotThrow(()=>verifySignature(r.body,r.headers['paddle-signature']+';h1='+'0'.repeat(64),secret,now));
 for(const n of [now+6000,now-6000])assert.throws(()=>verifySignature(r.body,r.headers['paddle-signature'],secret,n));
 assert.throws(()=>verifySignature(Buffer.concat([r.body,Buffer.from(' ')]),r.headers['paddle-signature'],secret,now));
 assert.throws(()=>verifySignature(e,r.headers['paddle-signature'],secret,now));
});
test('checkout authenticates owner, ignores no entitlements, verifies trial price and replays without another Paddle create',async()=>{
 const s=await seed();const body={store_id:s.id,request_id:randomUUID(),plan:'starter',interval:'month'};
 assert.equal((await run(api,req('checkout',body,null))).code,401);assert.equal((await run(api,req('checkout',body,'other'))).code,404);
 assert.equal((await run(api,req('checkout',{...body,quota_override:999}))).code,400);
 const before=created.length;const first=await run(api,req('checkout',body));assert.equal(first.code,200);assert.equal(first.body.trial_days,7);
 assert.equal((await run(api,req('checkout',body))).body.transaction_id,first.body.transaction_id);assert.equal(created.length,before+1);
 assert.equal((await run(api,req('checkout',{...body,request_id:randomUUID()}))).body.transaction_id,first.body.transaction_id);assert.equal(created.length,before+1);
 assert.equal((await snapshot(s)).access_active,false);
});
test('trial -> payment confirmation -> renewal -> scheduled cancel -> canceled; duplicate/stale events cannot regrant',async()=>{
 const s=await seed(other);const otherApi=createBillingHandlers({db,env,paddle,now:()=>now}).api;
 const make=await run(otherApi,req('checkout',{store_id:s.id,request_id:randomUUID(),plan:'starter',interval:'month'},'other'));assert.equal(make.code,200);
 const c=(await pg.query('select * from cc_private.paddle_checkouts where transaction_id=$1',[make.body.transaction_id])).rows[0];const b=sub(c);
 const original=await send('subscription.created',b);assert.equal((await snapshot(s)).status,'trialing');assert.equal((await snapshot(s)).query_limit,500);
 assert.equal((await run(webhook,signed(original.e))).body.duplicate,true);
 const extended={...b,items:[{...b.items[0],trial_dates:{starts_at:b.items[0].trial_dates.starts_at,ends_at:iso(now+20*86400000)}}]};await send('subscription.updated',extended);assert.ok(new Date((await snapshot(s)).access_until)<=new Date(b.items[0].trial_dates.starts_at).getTime()+7*86400000);
 const active={...b,status:'active',first_billed_at:iso(now-60000),current_billing_period:{starts_at:iso(now-60000),ends_at:iso(now+30*86400000)}};
 await send('subscription.activated',active);assert.equal((await snapshot(s)).access_active,false);
 await send('transaction.completed',payment(c,active,{billing_period:{starts_at:iso(now+86400000),ends_at:iso(now+30*86400000)}}));assert.equal((await snapshot(s)).access_active,false,'A future billing-period payment must not unlock current unpaid access');
 const paid=payment(c,active,{status:'paid'});await send('transaction.paid',paid);assert.equal((await snapshot(s)).access_active,false);
 await send('transaction.completed',{...paid,status:'completed'});assert.equal((await snapshot(s)).access_active,true);const anchor=(await snapshot(s)).monthly_anchor;
 const renewal={...active,current_billing_period:{starts_at:iso(now-30000),ends_at:iso(now+60*86400000)}};await send('subscription.updated',renewal);
 assert.equal(new Date((await snapshot(s)).access_until).toISOString(),active.current_billing_period.ends_at);
 await send('transaction.completed',payment(c,renewal));assert.equal(new Date((await snapshot(s)).access_until).toISOString(),renewal.current_billing_period.ends_at);assert.equal((await snapshot(s)).monthly_anchor,anchor);
 const cancel={...renewal,scheduled_change:{action:'cancel',effective_at:renewal.current_billing_period.ends_at}};await send('subscription.updated',cancel);assert.equal((await snapshot(s)).cancel_at_period_end,true);assert.equal((await snapshot(s)).access_active,true);
 await send('subscription.canceled',{...cancel,status:'canceled',current_billing_period:null,canceled_at:iso(now),scheduled_change:null});assert.equal((await snapshot(s)).access_active,false);
 await run(webhook,signed(original.e));assert.equal((await snapshot(s)).access_active,false);
 assert.equal((await pg.query('select count(*)::int n from cc_private.paddle_trials where owner_id=$1',[other])).rows[0].n,1);
});
test('owner cannot obtain repeated trial and expiry blocks AI without requiring cron/webhook',async()=>{
 const fresh=await seed(other);const eligible=await db.rpc('cc_billing_operation',{p_action:'inspect',p_input:{owner_id:other,store_id:fresh.id}});assert.equal(eligible.data.trial_available,false);
 const freshOwner=randomUUID();identities.set('expiry-owner',freshOwner);await pg.query('insert into auth.users(id) values($1)',[freshOwner]);
 const c=await checkout(await seed(freshOwner),'expiry-owner');const b=sub(c);await send('subscription.trialing',b);const s={id:c.store_id,domain:(await pg.query('select domain from public.cc_stores where id=$1',[c.store_id])).rows[0].domain};
 assert.equal((await snapshot(s)).access_active,true);assert.equal((await snapshot(s)).status,'trialing');
 await pg.query("update public.cc_stores set access_until=now()-interval '1 second' where id=$1",[s.id]);let generated=0;
 const h=createUsageHandler(async()=>{generated++;},{db,authorize:async()=>({})});const r=await run(h,{method:'POST',body:{domain:s.domain,request_id:randomUUID(),question:'Known facts?'}});assert.equal(r.body.blocked,true);assert.equal(generated,0);
});
test('payment may arrive before subscription; customer/store binding and unknown signatures fail closed',async()=>{
 const s=await seed();const c=await checkout(s);const b=sub(c,{status:'active',current_billing_period:{starts_at:iso(now-1000),ends_at:iso(now+30*86400000)}});
 await send('transaction.completed',payment(c,b,{id:c.transaction_id,billing_period:null}));assert.equal((await snapshot(s)).access_active,false);
 await send('subscription.created',b);assert.equal((await snapshot(s)).access_active,true);
 const bad=event('subscription.updated',{...b,customer_id:pid('ctm',99),updated_at:iso(now+(++eventseq)*1000)});assert.equal((await run(webhook,signed(bad))).code,503);
 const missing=signed(event('subscription.updated',{...b,id:pid('sub',999),transaction_id:pid('txn',999),updated_at:iso(now)}));assert.equal((await run(webhook,missing)).code,503);
 const invalid=signed(event('subscription.updated',b));invalid.headers['paddle-signature']+='x';assert.equal((await run(webhook,invalid)).code,401);
});
test('plan changes require confirmed higher-tier payment; downgrade preserves counters and webhook respects admin hold',async()=>{
 const s=await seed();const c=await checkout(s);const b=sub(c,{status:'active',current_billing_period:{starts_at:iso(now-1000),ends_at:iso(now+30*86400000)}});await send('subscription.created',b);await send('transaction.completed',payment(c,b));
 const pro=env.PADDLE_PRICE_PRO_MONTHLY;await db.rpc('cc_billing_operation',{p_action:'register_price',p_input:{environment:'sandbox',price_id:pro,plan:'pro',billing_interval:'month',trial_days:0}});
 const upgraded={...b,items:[{quantity:1,price:{id:pro}}]};await send('subscription.updated',upgraded);assert.equal((await snapshot(s)).access_active,false);
 await send('transaction.completed',payment(c,upgraded));assert.equal((await snapshot(s)).plan,'pro');assert.equal((await snapshot(s)).query_limit,2500);assert.equal((await snapshot(s)).access_active,true);
 const originalAnchor=(await snapshot(s)).monthly_anchor;
 const bounds=(await pg.query('select * from cc_private.month_bounds($1,now())',[originalAnchor])).rows[0];
 await pg.query('insert into public.cc_usage_periods(store_id,period_start,period_end,used) values($1,$2,$3,12)',[s.id,bounds.period_start,bounds.period_end]);
 await send('subscription.updated',b);assert.equal((await snapshot(s)).plan,'starter');assert.equal((await snapshot(s)).access_active,true);assert.equal((await snapshot(s)).query_count,12);assert.equal((await snapshot(s)).monthly_anchor,originalAnchor);
 const patch=validatedPatch({pause:true},await snapshot(s),true);assert.equal(patch.billing_hold,true);await pg.query("update public.cc_stores set billing_hold=true,status='paused' where id=$1",[s.id]);await send('subscription.updated',upgraded);assert.equal((await snapshot(s)).status,'paused');
});
test('unknown prices revoke paid access; older events and duplicate payload conflicts cannot restore it',async()=>{
 const s=await seed(),c=await checkout(s),b=sub(c,{status:'active',current_billing_period:{starts_at:iso(now-1000),ends_at:iso(now+30*86400000)}});
 const original=await send('subscription.created',b);await send('transaction.completed',payment(c,b));assert.equal((await snapshot(s)).access_active,true);
 await send('subscription.updated',{...b,items:[{quantity:1,price:{id:pid('pri',999999)}}]});assert.equal((await snapshot(s)).access_active,false);
 const altered={...original.e,data:{...original.e.data,status:'trialing'}};assert.equal((await run(webhook,signed(altered))).code,503);assert.equal((await snapshot(s)).access_active,false);
 assert.equal((await run(webhook,signed(original.e))).body.duplicate,true);assert.equal((await snapshot(s)).access_active,false);
});
test('checkout transport ambiguity never creates a second Paddle transaction for the same request',async()=>{
 const s=await seed();let creates=0;const ambiguous=createBillingHandlers({db,env,paddle:async(path,opts)=>{if(path.startsWith('/prices/'))return paddle(path,opts);creates++;const e=new Error('No acknowledgment');e.status=503;e.code='PADDLE_REQUEST_UNCONFIRMED';throw e;}}).api;
 const r=req('checkout',{store_id:s.id,request_id:randomUUID(),plan:'starter',interval:'month'});assert.equal((await run(ambiguous,r)).code,503);assert.equal((await run(ambiguous,r)).code,409);assert.equal(creates,1);assert.equal((await snapshot(s)).access_active,false);
});
test('concurrent checkout submissions create at most one provider transaction',async()=>{
 const s=await seed();const body={store_id:s.id,request_id:randomUUID(),plan:'starter',interval:'month'};const before=created.length;
 const answers=await Promise.all(Array.from({length:8},()=>run(api,req('checkout',body))));assert.equal(created.length,before+1);assert.ok(answers.some(r=>r.code===200));assert.ok(answers.every(r=>[200,409].includes(r.code)));
});
test('past due blocks access and a late cancellation of an old subscription cannot disable its replacement',async()=>{
 const s=await seed(),c=await checkout(s),old=sub(c,{status:'active',current_billing_period:{starts_at:iso(now-1000),ends_at:iso(now+30*86400000)}});
 await send('subscription.created',old);await send('transaction.completed',payment(c,old));assert.equal((await snapshot(s)).access_active,true);
 await send('subscription.past_due',{...old,status:'past_due'});assert.equal((await snapshot(s)).access_active,false);
 const canceled={...old,status:'canceled',current_billing_period:null,canceled_at:iso(now)};await send('subscription.canceled',canceled);
 const replacement=await checkout(s),b=sub(replacement,{status:'active',current_billing_period:old.current_billing_period});await send('subscription.created',b);await send('transaction.completed',payment(replacement,b));assert.equal((await snapshot(s)).access_active,true);
 await send('subscription.canceled',canceled);assert.equal((await snapshot(s)).paddle_subscription_id,b.id);assert.equal((await snapshot(s)).access_active,true);
});
test('provider client is sandbox by default and does not log credentials or accept invalid success data',async()=>{
 let called;const client=paddleClient({env:{PADDLE_API_KEY:'synthetic-api-secret'},fetch:async(url,init)=>{called={url,init};return {ok:true,json:async()=>({data:{id:'ok'}})};}});
 assert.equal((await client('/prices/example')).id,'ok');assert.ok(called.url.startsWith('https://sandbox-api.paddle.com/'));
 const invalid=paddleClient({env:{PADDLE_API_KEY:'synthetic-api-secret'},fetch:async()=>({ok:true,json:async()=>({})})});await assert.rejects(invalid('/prices/example'),/PADDLE_INVALID_RESPONSE/);
});
test('unbound events return retry and do not poison the dedupe ledger',async()=>{
 const c=await checkout(await seed());const b=sub(c,{transaction_id:pid('txn',999998)});const e=event('subscription.created',b);assert.equal((await run(webhook,signed(e))).code,503);
 assert.equal((await pg.query('select count(*)::int n from cc_private.paddle_events where event_id=$1',[e.event_id])).rows[0].n,0);
});
test('migration and synthetic billing lifecycle preserve all 20 legacy rows unmapped',async()=>{
 const after=(await pg.exec(require('node:fs').readFileSync('scripts/supabase-history-fingerprint.sql','utf8'))).find(r=>r.rows?.[0]?.original_history_fingerprint).rows[0];assert.deepEqual(after,legacyFingerprint);
 assert.equal((await pg.query('select count(*)::int n from public.questions where cc_store_id is not null')).rows[0].n,0);
});
test('cancel/plan routes only submit Paddle commands; client flags cannot change authoritative access',async()=>{
 const s=(await pg.query("select s.* from public.cc_stores s join cc_private.paddle_subscriptions b on b.store_id=s.id where s.owner_id=$1 and b.status='active' limit 1",[owner])).rows[0];assert.ok(s);
 const before=await snapshot(s);calls=[];const r=await run(api,req('cancel',{store_id:s.id}));assert.equal(r.code,202);assert.ok(calls.some(c=>c.path.endsWith('/cancel')&&c.body.effective_from==='next_billing_period'));assert.equal((await snapshot(s)).access_until,before.access_until);
 const change=await run(api,req('plan',{store_id:s.id,plan:'business',interval:'month'}));assert.equal(change.code,202);assert.ok(calls.some(c=>c.body?.on_payment_failure==='prevent_change'));assert.equal((await snapshot(s)).plan,before.plan);
});
test('billing private tables/RPCs are unavailable to anon and authenticated roles',async()=>{
 for(const role of ['anon','authenticated']){await pg.exec('set role '+role);try{await assert.rejects(pg.query('select * from cc_private.paddle_events'),/permission denied/);await assert.rejects(pg.query("select public.cc_billing_operation('inspect','{}')"),/permission denied/);}finally{await pg.exec('reset role');}}
});
test('prepared read-only billing postflight reports private RLS and service-only wrappers',async()=>{
 const results=await pg.exec(require('node:fs').readFileSync('scripts/paddle-readonly-postflight.sql','utf8'));const rows=results.flatMap(r=>r.rows||[]);
 assert.equal(rows.find(r=>'all_six_private_tables_have_rls'in r).all_six_private_tables_have_rls,true);
 const rpcs=rows.filter(r=>r.rpc);assert.equal(rpcs.length,2);for(const r of rpcs)for(const flag of ['invoker_wrapper','service_allowed','anon_denied','authenticated_denied'])assert.equal(r[flag],true,r.rpc+' '+flag);
});
test('shared HTTP handler receives exact raw webhook bytes before JSON parser',async()=>{
 const {createApp}=require('../server');const app=createApp({db,hasApiKey:true,billingOptions:{env,paddle,now:()=>now}});const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{const e=event('unrelated.event',{});const r=signed(e);const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/billing/webhook',{method:'POST',headers:{'Content-Type':'application/json',...r.headers},body:r.body});assert.equal(response.status,200);assert.equal((await response.json()).ignored,true);
 const changed=await fetch('http://127.0.0.1:'+server.address().port+'/api/billing/webhook',{method:'POST',headers:{'Content-Type':'application/json',...r.headers},body:Buffer.concat([r.body,Buffer.from(' ')])});assert.equal(changed.status,401);
 }finally{await new Promise(r=>server.close(r));}
});
