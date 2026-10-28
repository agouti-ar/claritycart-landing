const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {createTestDb}=require('./helpers/test-db');const {buildBundle,migrationBody,sources}=require('../scripts/build-rollout-sql');
test('generated rollout preserves authoritative migration bodies and committed artifact',()=>{
 const bundle=buildBundle();assert.equal(fs.readFileSync('scripts/supabase-stage1-4-rollout.sql','utf8').replace(/\r\n/g,'\n'),bundle);
 let previous=-1;for(const source of sources){const body=migrationBody(fs.readFileSync(source,'utf8'));const at=bundle.indexOf(body);assert.ok(at>previous);previous=at;}
 assert.equal((bundle.match(/^begin;$/gm)||[]).length,1);assert.equal((bundle.match(/^commit;$/gm)||[]).length,1);
});
test('atomic rollout preserves 20 unmapped questions, validates grants and rejects replay',async()=>{
 const bundle=buildBundle();const {pg}=await createTestDb({migrationBundle:bundle,beforeMigrations:async pg=>{
  await pg.exec("insert into public.questions(store_domain,question_text) select 'legacy.test','synthetic '||n from generate_series(1,20) n");
 }});
 try {
  assert.equal((await pg.query('select count(*)::int n from public.questions where cc_store_id is null')).rows[0].n,20);
  const checks=(await pg.exec(fs.readFileSync('scripts/supabase-stage4-postflight.sql','utf8'))).flatMap(r=>r.rows||[]);
  assert.equal(checks.filter(r=>r.check_name).length,11);for(const r of checks.filter(r=>r.check_name))assert.equal(r.passed,true,r.check_name);
  await assert.rejects(pg.exec(bundle),/ROLLOUT_ALREADY_OR_PARTIALLY_APPLIED/);await pg.exec('rollback');
  assert.equal((await pg.query('select count(*)::int n from public.questions')).rows[0].n,20);
 }finally{await pg.close();}
});
test('changed count or failure after all DDL leaves no partial migration and permits a safe retry',async()=>{
 const bundle=buildBundle();const {pg}=await createTestDb({migrationBundle:bundle,beforeMigrations:async pg=>{
  await assert.rejects(pg.exec(bundle),/ROLLOUT_HISTORY_COUNT_CHANGED/);await pg.exec('rollback');
  await pg.exec("insert into public.questions(store_domain,question_text) select 'legacy.test','synthetic '||n from generate_series(1,20) n");
  const failing=bundle.replace("select 'PASS' as history_preserved",()=>"do $$begin raise exception 'SYNTHETIC_FAILURE';end;$$;\nselect 'PASS' as history_preserved");
  await assert.rejects(pg.exec(failing),/SYNTHETIC_FAILURE/);await pg.exec('rollback');
  assert.equal((await pg.query("select to_regclass('public.chat_requests') is null as absent")).rows[0].absent,true);
  assert.equal((await pg.query('select count(*)::int n from public.questions')).rows[0].n,20);
 }});
 try{assert.equal((await pg.query('select count(*)::int n from public.questions where cc_store_id is null')).rows[0].n,20);}finally{await pg.close();}
});
