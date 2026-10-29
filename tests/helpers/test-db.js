const {PGlite}=require('@electric-sql/pglite');
const {readFileSync,readdirSync}=require('node:fs');
async function createTestDb(options={}) {
 const pg=new PGlite();
 await pg.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 grant execute on function auth.jwt() to authenticated;
 create table public.questions(id bigint generated always as identity primary key,created_at timestamptz not null default timezone('utc',now()),store_domain text not null,question_text text not null,product_context text);
 alter table public.questions enable row level security;
 create policy "Allow public inserts" on public.questions for insert to anon with check(true);
 create policy "Allow public select" on public.questions for select to anon using(true);
 create policy "Allow owners to read their own questions" on public.questions for select to authenticated using(store_domain=auth.jwt()->'user_metadata'->>'store_domain');
 grant select,insert on public.questions to anon,authenticated;`);
 if(options.beforeMigrations)await options.beforeMigrations(pg);
 if(options.migrationBundle)await pg.exec(options.migrationBundle);
 else {
 await pg.exec(readFileSync('migrations/001_chat_request_idempotency.sql','utf8'));
 const migration=readdirSync('supabase/migrations').find(x=>x.endsWith('_server_entitlements_and_monthly_quota.sql'));
 await pg.exec(readFileSync('supabase/migrations/'+migration,'utf8'));
 if(options.security) {await pg.exec('create policy legacy_broad_read on public.questions for select using (true); grant select(id) on public.questions to anon; grant update(question_text) on public.questions to authenticated;'); const migration=readdirSync('supabase/migrations').find(x=>x.endsWith('_widget_security_and_store_binding.sql'));await pg.exec(readFileSync('supabase/migrations/'+migration,'utf8'));}
 }
 if(options.billing){const billing=readdirSync('supabase/migrations').find(x=>x.endsWith('_paddle_subscription_lifecycle.sql'));await pg.exec(readFileSync('supabase/migrations/'+billing,'utf8'));}
 if(options.freezeRateClock) {
  const definition=(await pg.query("select pg_get_functiondef('cc_private.consume_rate(text,integer,integer)'::regprocedure) as definition")).rows[0].definition;
  if(!definition.includes('clock_timestamp()'))throw new Error('Test clock marker missing');
  await pg.exec(definition.replaceAll('clock_timestamp()',()=>"timestamptz '2026-10-27 12:00:00+00'"));
 }
 const db={rpc(name,args){
  if(!['claim_chat_request','complete_chat_request','get_cc_store_snapshot','consume_cc_rate_limit','claim_verified_chat_request','cc_billing_operation','apply_cc_paddle_event'].includes(name))throw new Error('Unexpected RPC');
  const entries=Object.entries(args);const sql='select public.'+name+'('+entries.map(([k],i)=>k+' => $'+(i+1)).join(',')+') as result';
  const p=pg.query(sql,entries.map(([,v])=>typeof v==='object'?JSON.stringify(v):v)).then(r=>({data:r.rows[0].result,error:null}),error=>({data:null,error}));
  p.abortSignal=()=>p;return p;
 }};
 db.from=(table)=>{
  if(table!=='cc_stores')throw new Error('Unexpected table');
  const filters=[];let patch,insert,limit=1;
  const query={select(){return this;},eq(k,v){if(!['id','owner_id','domain','domain_verification_token'].includes(k))throw new Error('Unexpected filter');filters.push([k,v]);return this;},order(){return this;},limit(n){limit=n;return this;},update(value){patch=value;return this;},insert(value){insert=value;return this;},
   async execute(multiple=false){
    const values=[];let sql;
    if(insert){const keys=Object.keys(insert);if(keys.some(k=>!['owner_id','domain','plan','status'].includes(k)))throw new Error('Unexpected insert');try{const r=await pg.query('insert into public.cc_stores('+keys.join(',')+') values('+keys.map((k,i)=>'$'+(i+1)).join(',')+') returning *',Object.values(insert));return {data:r.rows[0],error:null};}catch(error){return {data:null,error};}}
    if(patch){const sets=Object.entries(patch).map(([k,v])=>{if(!['domain','plan','quota_override','status','access_until','settings','cancel_at_period_end','domain_verified_at','billing_hold'].includes(k))throw new Error('Unexpected update');values.push(typeof v==='object'?JSON.stringify(v):v);return k+'=$'+values.length;});sql='update public.cc_stores set '+sets.join(',');}
    else sql='select * from public.cc_stores';
    sql+=' where '+filters.map(([k,v])=>{values.push(v);return k+'=$'+values.length;}).join(' and ');
    sql+=patch?' returning *':' order by created_at limit '+limit;
    try{const r=await pg.query(sql,values);return {data:multiple?r.rows:r.rows[0]||null,error:null};}catch(error){return {data:null,error};}
   },async maybeSingle(){return this.execute();},async single(){return this.execute();},then(resolve,reject){return this.execute(true).then(resolve,reject);}};return query;
 };
 return {pg,db};
}
module.exports={createTestDb};
