const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { createUsageHandler } = require('../lib/usage-handler');
const { createLocalChatHandler } = require('../lib/local-chat');
let pg, db;
before(async () => {
  pg = new PGlite();
  await pg.exec('create role anon; create role authenticated; create role service_role; create table public.questions (id bigserial primary key, store_domain text, question_text text, product_context text, created_at timestamptz default now()); grant select, insert on public.questions to anon, authenticated;');
  await pg.exec(readFileSync('migrations/001_chat_request_idempotency.sql', 'utf8'));
  db = { rpc(name, args) {
    const entries = Object.entries(args);
    const sql = 'select public.' + name + '(' + entries.map(([key], i) => key + ' => $' + (i+1)).join(',') + ') as result';
    const promise = pg.query(sql, entries.map(([,v]) => typeof v === 'object' ? JSON.stringify(v) : v))
      .then(r => ({ data: r.rows[0].result, error: null }), error => ({ data: null, error }));
    promise.abortSignal = () => promise;
    return promise;
  } };
});
after(async () => { await pg?.close(); });
function request(id = randomUUID(), extra = {}) {
  return { method: 'POST', body: { request_id: id, domain: 'example.com', question: 'Known product?', productContext: { title: 'Product' }, ...extra } };
}
async function run(handler, req) {
  const res = { code: 200, headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(n) { this.code=n; return this; }, json(v) { this.body=v; return this; }, end() { return this; } };
  await handler(req,res); return res;
}
async function count() { return Number((await pg.query('select count(*) as n from public.questions')).rows[0].n); }
const success = async (req,res) => res.status(200).json({ answer: 'Grounded answer', usedModel: 'test' });

test('commit precedes success; repeated request and fresh handler return same result with one row', async () => {
  const n = await count(); let generations=0;
  const generator = async (req,res) => { generations++; return success(req,res); };
  const req=request();
  const a=await run(createUsageHandler(generator,{db,authorize:async()=>({})}),req);
  assert.equal(a.code,200); assert.equal(a.body.usageRecorded,true); assert.equal(await count(),n+1);
  const b=await run(createUsageHandler(generator,{db,authorize:async()=>({})}),req);
  assert.deepEqual(b.body,a.body); assert.equal(generations,1); assert.equal(await count(),n+1);
});
test('20 concurrent deliveries of one ID produce only one generation and one event', async () => {
  const n=await count(); let generations=0;
  const handler=createUsageHandler(async(req,res)=>{ generations++; await new Promise(r=>setTimeout(r,30)); return success(req,res); },{db,authorize:async()=>({})});
  const req=request(); const results=await Promise.all(Array.from({length:20},()=>run(handler,req)));
  assert.equal(generations,1); assert.equal(await count(),n+1);
  assert.ok(results.every(r=>r.code===200 || r.body.error==='REQUEST_PENDING'));
  assert.equal((await run(handler,req)).body.usageRecorded,true); assert.equal(await count(),n+1);
});
test('independent concurrent requests are each recorded once', async () => {
  const n=await count(); const handler=createUsageHandler(success,{db,authorize:async()=>({})});
  const results=await Promise.all(Array.from({length:5},()=>run(handler,request())));
  assert.ok(results.every(r=>r.code===200)); assert.equal(await count(),n+5);
});
for(const flag of ['blocked','limitReached']) test(flag+' response records no usage and is replayed',async()=>{
  const n=await count(); let calls=0;
  const h=createUsageHandler(async(req,res)=>{calls++;res.status(200).json({answer:'Unavailable',[flag]:true});},{db,authorize:async()=>({})});
  const req=request(); const a=await run(h,req); await run(h,req);
  assert.equal(a.body.usageRecorded,false); assert.equal(calls,1); assert.equal(await count(),n);
});
test('AI error is not usage and replays without another upstream request',async()=>{
  const n=await count();let calls=0;
  const h=createUsageHandler(async()=>{calls++;throw new Error('Upstream failure');},{db,authorize:async()=>({})});
  const req=request();const a=await run(h,req);await run(h,req);
  assert.equal(a.code,502);assert.equal(a.body.usageRecorded,false);assert.equal(calls,1);assert.equal(await count(),n);
});
test('AI timeout is cancelled, not charged, and remains replayable',async()=>{
  const n=await count();
  const h=createUsageHandler(async req=>new Promise((resolve,reject)=>req.signal.addEventListener('abort',()=>reject(new Error('timeout')))),{db,authorize:async()=>({}),aiTimeoutMs:15});
  const req=request();const a=await run(h,req);const b=await run(h,req);
  assert.equal(a.code,504);assert.equal(a.body.error,'AI_TIMEOUT');assert.deepEqual(a.body,b.body);assert.equal(await count(),n);
});
test('same ID with modified payload or domain is rejected',async()=>{
  const n=await count();const h=createUsageHandler(success,{db,authorize:async()=>({})});const req=request();await run(h,req);
  for(const change of [{question:'changed'},{domain:'another.test'}]){
    const r=await run(h,request(req.body.request_id,change));assert.equal(r.code,409);assert.equal(r.body.error,'REQUEST_ID_CONFLICT');
  }
  assert.equal(await count(),n+1);
});
test('unavailable persistence fails closed before generation',async()=>{
  let generated=false;
  const badDb={rpc(){return {abortSignal:async()=>({error:{code:'DB_OFFLINE'}})};}};
  const h=createUsageHandler(async()=>{generated=true;},{db:badDb,authorize:async()=>({})});
  const r=await run(h,request());assert.equal(r.code,503);assert.equal(generated,false);
});
test('transaction rollback: failed question insert cannot leave a completed request',async()=>{
  const id=randomUUID(),owner=randomUUID(),n=await count();
  await db.rpc('claim_chat_request',{p_request_id:id,p_domain:'rollback.test',p_fingerprint:'x',p_owner:owner});
  await pg.exec("alter table public.questions add constraint test_reject check (question_text <> 'reject')");
  const args={p_request_id:id,p_owner:owner,p_response:{answer:'OK',usageRecorded:true},p_http_status:200,p_record_usage:true,p_question:'reject',p_product_context:''};
  assert.ok((await db.rpc('complete_chat_request',args)).error);
  assert.equal((await pg.query('select state from public.chat_requests where request_id=$1',[id])).rows[0].state,'processing');
  assert.equal(await count(),n);
  await pg.exec('alter table public.questions drop constraint test_reject');
  assert.equal((await db.rpc('complete_chat_request',args)).error,null);
  assert.equal((await db.rpc('complete_chat_request',args)).error,null);
  assert.equal(await count(),n+1);
});
test('lost completion acknowledgment replays committed response without double insert',async()=>{
  const n=await count();let lose=true,generations=0;
  const flaky={rpc(name,args){const p=db.rpc(name,args).then(result=>{if(name==='complete_chat_request'&&lose){lose=false;return {error:{code:'LOST_ACK'}};}return result;});p.abortSignal=()=>p;return p;}};
  const h=createUsageHandler(async(req,res)=>{generations++;return success(req,res);},{db:flaky,authorize:async()=>({})});
  const req=request();assert.equal((await run(h,req)).code,503);assert.equal(await count(),n+1);
  assert.equal((await run(h,req)).code,200);assert.equal(generations,1);assert.equal(await count(),n+1);
});
test('anon/authenticated cannot directly insert questions or execute usage RPC',async()=>{
  for(const role of ['anon','authenticated']){
    await pg.exec('set role '+role);
    try {
      await assert.rejects(pg.query("insert into public.questions(question_text) values ('bypass')"),/permission denied/);
      await assert.rejects(pg.query('select public.claim_chat_request($1,$2,$3,$4)',[randomUUID(),'x','x',randomUUID()]),/permission denied/);
      await assert.rejects(pg.query('select * from public.chat_requests'),/permission denied/);
    } finally {await pg.exec('reset role');}
  }
});
test('local proxy forwards request ID and never invokes the local writer',async()=>{
  let localCalled=false; const req=request(); let sent;
  const h=createLocalChatHandler(()=>{localCalled=true;},{hasApiKey:false,fetch:async(url,init)=>{sent=JSON.parse(init.body);return {ok:true,status:200,json:async()=>({answer:'OK',requestId:sent.request_id,usageRecorded:true})};}});
  assert.equal((await run(h,req)).code,200);assert.equal(sent.request_id,req.body.request_id);assert.equal(localCalled,false);
});
test('local AI path uses shared handler; older remote API cannot claim usage success',async()=>{
  let called=false;const req=request();
  await run(createLocalChatHandler(async(req,res)=>{called=true;res.json({answer:'local'});},{hasApiKey:true}),req);assert.equal(called,true);
  const proxy=createLocalChatHandler(success,{hasApiKey:false,fetch:async()=>({ok:true,status:200,json:async()=>({answer:'old'})})});
  assert.equal((await run(proxy,req)).body.error,'UPSTREAM_VERSION_MISMATCH');
});

test('dashboard counters reflect committed usage, including a limited row response',async()=>{
  const vm=require('node:vm'); const src=readFileSync('dashboard.html','utf8');
  const start=src.indexOf('async function updateUsageAndQueries');const end=src.indexOf('// Initialize dashboard UI once',start);
  const elements={'total-questions':{},'total-usage':{}};
  const ctx={document:{getElementById:id=>elements[id]||null},console,
    fetchAccount:async()=>({query_count:Number((await pg.query("select count(*) as n from public.questions where store_domain='counter.test'")).rows[0].n),query_limit:500}),
    supabaseClient:{from:()=>({select:()=>({eq:async(key,domain)=>{
      const rows=await pg.query('select * from public.questions where store_domain=$1 limit 1',[domain]);
      const total=await pg.query('select count(*) as n from public.questions where store_domain=$1',[domain]);
      return {data:rows.rows,count:Number(total.rows[0].n),error:null};
    }})})}};
  vm.createContext(ctx);vm.runInContext(src.slice(start,end),ctx);
  const h=createUsageHandler(success,{db,authorize:async()=>({})}),req=request(undefined,{domain:'counter.test'});
  await run(h,req);await run(h,req);await ctx.updateUsageAndQueries('counter.test',500,'Starter',false);
  assert.equal(elements['total-usage'].textContent,1);
  await run(h,request(undefined,{domain:'counter.test'}));await ctx.updateUsageAndQueries('counter.test',500,'Starter',false);
  assert.equal(elements['total-usage'].textContent,2);assert.equal(elements['total-questions'].textContent,2);
});
test('invalid request does not generate or write usage',async()=>{
  const n=await count();let called=false;const h=createUsageHandler(async()=>{called=true;},{db,authorize:async()=>({})});
  for(const extra of [{request_id:'bad'},{domain:''},{question:''}]) assert.equal((await run(h,request(undefined,extra))).code,400);
  assert.equal(called,false);assert.equal(await count(),n);
});

test('crashed request expires without regeneration or a late usage write',async()=>{
  const id=randomUUID(),owner=randomUUID(),n=await count();
  await db.rpc('claim_chat_request',{p_request_id:id,p_domain:'example.com',p_fingerprint:'x',p_owner:owner});
  await pg.query("update public.chat_requests set created_at=now()-interval '3 minutes' where request_id=$1",[id]);
  const replay=await db.rpc('claim_chat_request',{p_request_id:id,p_domain:'example.com',p_fingerprint:'x',p_owner:randomUUID()});
  assert.equal(replay.data.state,'completed');assert.equal(replay.data.response.error,'REQUEST_EXPIRED');
  const late=await db.rpc('complete_chat_request',{p_request_id:id,p_owner:owner,p_response:{answer:'late',usageRecorded:true},p_http_status:200,p_record_usage:true,p_question:'late',p_product_context:''});
  assert.equal(late.data.response.usageRecorded,false);assert.equal(await count(),n);
});
test('actual AI adapter saves success and does not save empty provider responses',async(t)=>{
  const generate=require('../api/chat').generateResponse;
  const previous={...process.env};process.env.GEMINI_API_KEY='test';process.env.SUPABASE_SERVICE_KEY='test';
  let empty=false;
  t.mock.method(globalThis,'fetch',async(url)=>{
    if(url.includes('/auth/v1/admin/users')) return {ok:true,json:async()=>({users:[]})};
    if(url.includes('/rest/v1/questions')) return {ok:true,headers:{get:()=> '0-0/0'}};
    if(url.includes('generativelanguage.googleapis.com')) return {ok:true,json:async()=>empty?{candidates:[]}:{candidates:[{content:{parts:[{text:'Known facts'}]}}]}};
    throw new Error('Unexpected URL: '+url);
  });
  try {
    const n=await count(),h=createUsageHandler((req,res)=>generate({...req,entitlement:{plan:'starter',settings:{}}},res),{db,authorize:async()=>({})});
    assert.equal((await run(h,request())).body.usageRecorded,true);assert.equal(await count(),n+1);
    empty=true;const failed=await run(h,request());assert.equal(failed.code,502);assert.equal(failed.body.usageRecorded,false);assert.equal(await count(),n+1);
  } finally {
    for(const key of ['GEMINI_API_KEY','SUPABASE_SERVICE_KEY']){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  }
});
