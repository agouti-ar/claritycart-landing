const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
const {createTestDb}=require('./helpers/test-db');

test('migration chain preserves existing history; reviewed ID mapping isolates owners and monthly usage',async t=>{
 let before,beforeFingerprint;
 const fingerprintSql=readFileSync('scripts/supabase-history-fingerprint.sql','utf8');
 const {pg,db}=await createTestDb({security:true,beforeMigrations:async pg=>{
  await pg.exec("insert into public.questions(store_domain,question_text,product_context,created_at) values ('old.example','synthetic old',null,now()-interval '60 days'),('shared.example','synthetic current','synthetic context',now()),('shared.example','synthetic unassigned',null,now())");
  before=(await pg.query('select id,created_at,store_domain,question_text,product_context from public.questions order by id')).rows;
  beforeFingerprint=(await pg.exec(fingerprintSql)).find(r=>r.rows?.[0]?.original_history_fingerprint)?.rows[0];
 }});
 const owner=randomUUID(),other=randomUUID();let store,foreign;
 try {
  await pg.query('insert into auth.users(id) values($1),($2)',[owner,other]);
  store=(await pg.query("insert into public.cc_stores(owner_id,domain,status,access_start,access_until,monthly_anchor) values($1,'current.example','active',now()-interval '1 day',now()+interval '30 days',now()-interval '1 day') returning *",[owner])).rows[0];
  foreign=(await pg.query("insert into public.cc_stores(owner_id,domain) values($1,'foreign.example') returning *",[other])).rows[0];
  const source=readFileSync('scripts/legacy-question-mapping.sql','utf8');
  const plan=(id,s=store,expectedOwner=owner)=>`insert into cc_legacy_mapping_plan values (${id},'${s.id}','${expectedOwner}','${s.domain}','${before.find(q=>q.id===id).store_domain}');`;
  const execute=async(rows,apply=false)=>{
   const sql=source.replace('-- APPROVED_MAPPING_ROWS',()=>rows).replace("set local claritycart.apply_legacy_mapping = 'false';",()=>`set local claritycart.apply_legacy_mapping = '${apply}';`);
   try{return await pg.exec(sql);}catch(e){await pg.exec('rollback');throw e;}
  };
  await t.test('all migrations preserve original IDs, timestamps and content',async()=>{
   assert.deepEqual((await pg.query('select id,created_at,store_domain,question_text,product_context from public.questions order by id')).rows,before);
   assert.equal((await pg.query('select count(*)::int n from public.questions where cc_store_id is not null')).rows[0].n,0);
  });
  await t.test('read-only history fingerprint agrees before and after migration chain',async()=>{
   const after=(await pg.exec(fingerprintSql)).find(r=>r.rows?.[0]?.original_history_fingerprint)?.rows[0];
   assert.ok(beforeFingerprint);assert.deepEqual(after,beforeFingerprint);
  });
  await t.test('postflight checks all pass and all five RPCs remain service-only invoker wrappers',async()=>{
   const results=await pg.exec(readFileSync('scripts/supabase-stage4-postflight.sql','utf8'));
   const checks=results.flatMap(r=>r.rows||[]).filter(r=>r.check_name);
   assert.equal(checks.length,11);for(const c of checks)assert.equal(c.passed,true,c.check_name);
   const rpcs=results.flatMap(r=>r.rows||[]).filter(r=>r.rpc);
   assert.equal(rpcs.length,5);for(const r of rpcs)for(const key of ['invoker_wrapper','service_can_execute','anon_denied','authenticated_denied'])assert.equal(r[key],true,r.rpc+' '+key);
  });
  await t.test('production review file keeps all historical targets intentionally unmapped',()=>{
   const lines=readFileSync('docs/legacy-question-mapping-review.csv','utf8').trim().split(/\r?\n/).slice(1).map(line=>line.split(','));
   assert.deepEqual(lines.map(r=>Number(r[0])),[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,23]);
   for(const row of lines){assert.deepEqual(row.slice(2,5),['','','']);assert.equal(row[5],'KEEP_UNMAPPED');}
  });
  await t.test('default and filled dry runs never assign history',async()=>{
   await execute('');await execute(plan(before[1].id));
   assert.equal((await pg.query('select count(*)::int n from public.questions where cc_store_id is not null')).rows[0].n,0);
  });
  await t.test('stale/wrong owner or missing IDs fail atomically',async()=>{
   await assert.rejects(execute(plan(before[0].id)+plan(before[1].id,store,other),true),/Legacy mapping rejected/);
   await assert.rejects(execute(`insert into cc_legacy_mapping_plan values (999999,'${store.id}','${owner}','current.example','shared.example');`,true),/Legacy mapping rejected/);
   assert.equal((await pg.query('select count(*)::int n from public.questions where cc_store_id is not null')).rows[0].n,0);
  });
  await t.test('explicit mapping supports renamed domain, repeat is harmless, no matching-domain sweep',async()=>{
   const rows=plan(before[0].id)+plan(before[1].id);await execute(rows,true);await execute(rows,true);
   assert.equal((await pg.query('select cc_store_id from public.questions where id=$1',[before[2].id])).rows[0].cc_store_id,null);
   assert.equal((await db.rpc('get_cc_store_snapshot',{p_store_id:store.id})).data.query_count,1);
   assert.deepEqual((await pg.query('select id,created_at,store_domain,question_text,product_context from public.questions order by id')).rows,before);
   await assert.rejects(execute(plan(before[1].id,foreign,other),true),/Legacy mapping rejected/);
  });
  await t.test('owner reads mapped rows only; editable metadata grants no access',async()=>{
   await pg.exec('set role authenticated');
   try{
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
    assert.equal((await pg.query('select count(*)::int n from public.questions')).rows[0].n,2);
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
    await pg.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({user_metadata:{store_domain:'shared.example'}})]);
    assert.equal((await pg.query('select count(*)::int n from public.questions')).rows[0].n,0);
   }finally{await pg.exec('reset role');}
  });
  await t.test('mapping after first usage period is rejected instead of silently undercounting',async()=>{
   await db.rpc('claim_chat_request',{p_request_id:randomUUID(),p_domain:store.domain,p_fingerprint:'mapping-test',p_owner:randomUUID()});
   await assert.rejects(execute(plan(before[2].id),true),/usage period already exists/);
   assert.equal((await pg.query('select cc_store_id from public.questions where id=$1',[before[2].id])).rows[0].cc_store_id,null);
  });
 }finally{await pg.close();}
});
