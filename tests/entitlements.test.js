const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createTestDb}=require('./helpers/test-db');
const {createUsageHandler}=require('../lib/usage-handler');
const {validatedPatch}=require('../lib/store-access');
const {publicSettings}=require('../api/config');
let pg,db,counter=0;const owner=randomUUID(),other=randomUUID();
before(async()=>{({pg,db}=await createTestDb());await pg.query('insert into auth.users(id) values($1),($2)',[owner,other]);});
after(async()=>pg?.close());
async function seed(options={}) {
 const r=await pg.query(`insert into public.cc_stores(owner_id,domain,status,access_start,access_until,monthly_anchor,plan,quota_override,settings)
 values($1,$2,$3,now()-interval '1 day',now()+interval '60 days',now()-interval '1 day',$4,$5,$6) returning *`,
 [options.owner||owner,'store'+(++counter)+'.test',options.status||'active',options.plan||'starter',options.limit??3,JSON.stringify(options.settings||{})]);return r.rows[0];
}
function request(store,id=randomUUID(),extra={}) {return {method:'POST',body:{request_id:id,domain:store.domain,question:'Known facts?',productContext:{title:'Test'},...extra}};}
async function run(h,req){const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};await h(req,res);return res;}
const success=async(req,res)=>res.json({answer:'Known facts'});
async function used(s){const {data,error}=await db.rpc('get_cc_store_snapshot',{p_store_id:s.id});if(error)throw error;return data;}

test('quota=1: 25 distinct concurrent IDs admit one generation and one event',async()=>{
 const s=await seed({limit:1});let generated=0;
 const h=createUsageHandler(async(req,res)=>{generated++;await new Promise(r=>setTimeout(r,40));return success(req,res);},{db,authorize:async()=>({})});
 const results=await Promise.all(Array.from({length:25},()=>run(h,request(s))));
 assert.equal(generated,1);assert.equal(results.filter(r=>r.body.usageRecorded).length,1);
 assert.equal(results.filter(r=>r.body.limitReached).length,24);assert.equal((await used(s)).query_count,1);assert.equal((await used(s)).reserved,0);
});
test('same ID concurrent deliveries replay once under quota enforcement',async()=>{
 const s=await seed({limit:1}),req=request(s);let n=0;
 const h=createUsageHandler(async(req,res)=>{n++;await new Promise(r=>setTimeout(r,20));return success(req,res);},{db,authorize:async()=>({})});
 await Promise.all(Array.from({length:12},()=>run(h,req)));
 assert.equal((await run(h,req)).body.usageRecorded,true);assert.equal(n,1);assert.equal((await used(s)).query_count,1);
});
test('failed AI releases reservation for the next request',async()=>{
 const s=await seed({limit:1});await run(createUsageHandler(async()=>{throw new Error('AI failure');},{db,authorize:async()=>({})}),request(s));
 assert.equal((await used(s)).query_count,0);assert.equal((await used(s)).reserved,0);
 assert.equal((await run(createUsageHandler(success,{db,authorize:async()=>({})}),request(s))).body.usageRecorded,true);
});
test('unknown store, expired/paused/inactive access and zero quota fail closed before AI',async()=>{
 let n=0;const h=createUsageHandler(async(req,res)=>{n++;return success(req,res);},{db,authorize:async()=>({})});
 assert.equal((await run(h,request({domain:'unknown.test'}))).code,404);
 for(const status of ['inactive','paused'])assert.equal((await run(h,request(await seed({status})))).body.blocked,true);
 const expired=await seed();await pg.query("update public.cc_stores set access_until=now()-interval '1 second' where id=$1",[expired.id]);
 assert.equal((await run(h,request(expired))).body.blocked,true);
 assert.equal((await run(h,request(await seed({limit:0})))).body.limitReached,true);assert.equal(n,0);
});
test('cancel at period end allows paid remaining time and never extends access',async()=>{
 const s=await seed({status:'canceled'});assert.equal((await run(createUsageHandler(success,{db,authorize:async()=>({})}),request(s))).body.usageRecorded,true);
 const patch=validatedPatch({cancel_at_period_end:false},s);assert.deepEqual(patch,{cancel_at_period_end:false});assert.equal(patch.access_until,undefined);
});
test('frontend plan/limit/metadata are ignored; authoritative defaults are 500/2500/10000',async()=>{
 for(const [plan,limit] of [['starter',500],['pro',2500],['business',10000]]){
  const s=await seed({plan});await pg.query('update public.cc_stores set quota_override=null where id=$1',[s.id]);
  const r=await run(createUsageHandler(async(req,res)=>{assert.equal(req.entitlement.plan,plan);return success(req,res);},{db,authorize:async()=>({})}),request(s,undefined,{plan:'business',query_limit:999999,user_metadata:{plan:'business'}}));
  assert.equal(r.body.usageRecorded,true);assert.equal((await used(s)).query_limit,limit);
 }
 for(const body of [{plan:'business'},{query_limit:999999},{access_until:'2099-01-01'},{owner_id:other}])assert.throws(()=>validatedPatch(body,{settings:{}}),/Unsupported/);
});
test('monthly bounds preserve original Jan 31 anchor and use UTC',async()=>{
 for(const [anchor,at,start,end] of [
  ['2026-01-31T10:00:00Z','2026-02-28T11:00:00Z','2026-02-28T10:00:00Z','2026-03-31T10:00:00Z'],
  ['2024-01-31T10:00:00Z','2024-02-29T11:00:00Z','2024-02-29T10:00:00Z','2024-03-31T10:00:00Z'],
  ['2026-01-31T10:00:00Z','2026-03-31T10:00:00Z','2026-03-31T10:00:00Z','2026-04-30T10:00:00Z']]){
  const b=(await pg.query('select * from cc_private.month_bounds($1,$2)',[anchor,at])).rows[0];
  assert.equal(b.period_start.toISOString(),new Date(start).toISOString());assert.equal(b.period_end.toISOString(),new Date(end).toISOString());
 }
});
test('old all-time questions do not consume current monthly quota; current legacy rows do',async()=>{
 const s=await seed({limit:2});await pg.query("insert into public.questions(store_domain,question_text,created_at,cc_store_id) values($1,'old',now()-interval '40 days',$2),($1,'current',now(),$2)",[s.domain,s.id]);
 assert.equal((await used(s)).query_count,1);
 assert.equal((await run(createUsageHandler(success,{db,authorize:async()=>({})}),request(s))).body.usageRecorded,true);
 assert.equal((await used(s)).query_count,2);assert.equal((await run(createUsageHandler(success,{db,authorize:async()=>({})}),request(s))).body.limitReached,true);
});
test('request finishing after month boundary stays attributed to reserved period',async()=>{
 const s=await seed({limit:1}),id=randomUUID(),token=randomUUID();
 await db.rpc('claim_chat_request',{p_request_id:id,p_domain:s.domain,p_fingerprint:'test',p_owner:token});
 const bounds=(await used(s));
 await pg.query("insert into public.cc_usage_periods(store_id,period_start,period_end) values($1,$2::timestamptz-interval '1 month',$2)",[s.id,bounds.period_start]);
 await pg.query("update public.chat_requests set period_start=$2::timestamptz-interval '1 month',period_end=$2 where request_id=$1",[id,bounds.period_start]);
 const r=await db.rpc('complete_chat_request',{p_request_id:id,p_owner:token,p_response:{answer:'OK',usageRecorded:true},p_http_status:200,p_record_usage:true,p_question:'month boundary',p_product_context:''});
 assert.equal(r.error,null);assert.equal((await used(s)).query_count,0);
 assert.equal((await run(createUsageHandler(success,{db,authorize:async()=>({})}),request(s))).body.usageRecorded,true);assert.equal((await used(s)).query_count,1);
});
test('pause during AI generation prevents late success and releases reservation',async()=>{
 const s=await seed({limit:1});const h=createUsageHandler(async(req,res)=>{await pg.query("update public.cc_stores set status='paused' where id=$1",[s.id]);return success(req,res);},{db,authorize:async()=>({})});
 const r=await run(h,request(s));assert.equal(r.body.blocked,true);assert.equal(r.body.usageRecorded,false);assert.equal((await used(s)).query_count,0);assert.equal((await used(s)).reserved,0);
});
test('expired reservation releases quota; old worker cannot consume the new slot',async()=>{
 const s=await seed({limit:1}),id=randomUUID(),token=randomUUID();
 await db.rpc('claim_chat_request',{p_request_id:id,p_domain:s.domain,p_fingerprint:'x',p_owner:token});
 await pg.query("update public.chat_requests set created_at=now()-interval '3 minutes' where request_id=$1",[id]);
 assert.equal((await run(createUsageHandler(success,{db,authorize:async()=>({})}),request(s))).body.usageRecorded,true);
 const late=await db.rpc('complete_chat_request',{p_request_id:id,p_owner:token,p_response:{answer:'late'},p_http_status:200,p_record_usage:true,p_question:'late',p_product_context:''});
 assert.equal(late.data.response.usageRecorded,false);assert.equal((await used(s)).query_count,1);
});
test('RLS isolates owners and forbids frontend entitlement writes and privileged RPC',async()=>{
 const a=await seed(),b=await seed({owner:other});
 await pg.exec('set role authenticated');await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 try {
  const rows=(await pg.query('select id from public.cc_stores')).rows;
  assert.ok(rows.some(r=>r.id===a.id));assert.ok(!rows.some(r=>r.id===b.id));
  await assert.rejects(pg.query("update public.cc_stores set plan='business' where id=$1",[a.id]),/permission denied/);
  await assert.rejects(pg.query('select public.get_cc_store_snapshot($1)',[b.id]),/permission denied/);
  await assert.rejects(pg.query('select * from public.chat_requests'),/permission denied/);
 }finally{await pg.exec('reset role');}
});
test('config and actual AI adapter gate paid features by server entitlement',async(t)=>{
 assert.equal(publicSettings({plan:'starter',access_active:true,settings:{white_label:true,exit_intent:true,theme_preset:'neon_pop'}}).white_label,false);
 assert.equal(publicSettings({plan:'pro',access_active:true,settings:{exit_intent:true}}).exit_intent,true);
 assert.equal(publicSettings({plan:'business',access_active:false,settings:{white_label:true}}).white_label,false);
 const previous=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='test';let sent;
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.ok(url.includes('generativelanguage.googleapis.com'));sent=JSON.parse(init.body);return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'Known fact'}]}}]})};});
 try{
  const s=await seed({settings:{tone:'custom',custom_tone_prompt:'UNPAID_CUSTOM',friendly_tone:false}});
  const h=createUsageHandler(require('../api/chat').generateResponse,{db,authorize:async()=>({})});
  assert.equal((await run(h,request(s,undefined,{systemInstruction:'FRONTEND_OVERRIDE'}))).body.usageRecorded,true);
  assert.ok(!sent.system_instruction.parts[0].text.includes('FRONTEND_OVERRIDE'));assert.ok(!sent.system_instruction.parts[0].text.includes('UNPAID_CUSTOM'));
 }finally{if(previous===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previous;}
});

test('downgrade during generation cannot exceed the new limit',async()=>{
 const s=await seed({limit:1});const r=await run(createUsageHandler(async(req,res)=>{await pg.query('update public.cc_stores set quota_override=0 where id=$1',[s.id]);return success(req,res);},{db,authorize:async()=>({})}),request(s));
 assert.equal(r.body.limitReached,true);assert.equal(r.body.usageRecorded,false);assert.equal((await used(s)).query_count,0);
});
test('service role can execute RPC wrappers; anon cannot read protected stores',async()=>{
 const s=await seed();await pg.exec('set role service_role');
 try{const result=await db.rpc('get_cc_store_snapshot',{p_store_id:s.id});assert.equal(result.error,null);assert.equal(result.data.id,s.id);}finally{await pg.exec('reset role');}
 await pg.exec('set role anon');try{await assert.rejects(pg.query('select * from public.cc_stores'),/permission denied/);}finally{await pg.exec('reset role');}
});

test('account API verifies identity, rejects foreign store and blocks entitlement edits',async()=>{
 const {createAccountHandler}=require('../lib/store-access');const s=await seed(),foreign=await seed({owner:other});
 db.auth={getUser:async token=>token==='valid-owner-token'?{data:{user:{id:owner,user_metadata:{plan:'business'}}},error:null}:{data:{user:null},error:new Error('Invalid token')}};
 const h=createAccountHandler({db,authorize:async()=>({})});
 const req=(method='GET',body={},id=s.id,token='valid-owner-token')=>({method,body,query:{store_id:id},headers:{authorization:'Bearer '+token}});
 assert.equal((await run(h,req('GET',{},s.id,'forged-token'))).code,401);
 assert.equal((await run(h,req('GET',{},foreign.id))).code,404);
 assert.equal((await run(h,req())).body.plan,'starter');
 assert.equal((await run(h,req('PATCH',{plan:'business'}))).code,400);
 assert.equal((await run(h,req('PATCH',{query_limit:99999}))).code,400);
 assert.equal((await used(s)).plan,'starter');
 const updated=await run(h,req('PATCH',{settings:{friendly_tone:false},cancel_at_period_end:true}));
 assert.equal(updated.code,200);assert.equal(updated.body.settings.friendly_tone,false);assert.equal(updated.body.cancel_at_period_end,true);
 assert.equal(updated.body.query_limit,3);
});
