const express=require('express');
const {randomUUID}=require('node:crypto');
const {createTestDb}=require('../helpers/test-db');
const {createUsageHandler}=require('../../lib/usage-handler');
const {publicSettings}=require('../../api/config');
const {createWidgetSessionHandler,authorizeWidget}=require('../../lib/request-security');
(async()=>{
 const {pg,db}=await createTestDb({security:true});const owner=randomUUID();
 await pg.query('insert into auth.users(id) values($1)',[owner]);
 const store=(await pg.query("insert into public.cc_stores(owner_id,domain,status,access_start,access_until,quota_override) values($1,'integration.test','active',now()-interval '1 hour',now()+interval '1 day',3) returning *",[owner])).rows[0];
 db.auth={getUser:async token=>({data:{user:token==='synthetic-owner-token'?{id:owner,email:'darksteel180@gmail.com'}:null},error:null})};
 const secret='synthetic-integration-secret-'.repeat(3);
 let generations=0;const app=express();app.use(express.json());
 const handler=createUsageHandler(async(req,res)=>{generations++;await new Promise(r=>setTimeout(r,80));res.json({answer:'[Synthetic AI] '+req.body.productContext.description,usedModel:'synthetic-test-provider'});},{db,authorize:(req,db)=>authorizeWidget(req,db,{secret})});
 app.post('/api/chat',handler);
 app.post('/api/widget-session',createWidgetSessionHandler({db,secret}));
 app.get('/api/config',async(req,res)=>{const {data}=await db.rpc('get_cc_store_snapshot',{p_store_id:store.id});res.json(publicSettings(data));});
 app.get('/test/state',async(req,res)=>{const {data}=await db.rpc('get_cc_store_snapshot',{p_store_id:store.id});const rows=await pg.query('select count(*)::int as n from public.questions where cc_store_id=$1',[store.id]);res.json({usage:data.query_count,rows:rows.rows[0].n,reserved:data.reserved,generations});});
 app.get('/clarity.js',(req,res)=>res.sendFile(require('node:path').resolve('clarity.js')));
 app.get('/xss',(req,res)=>{
  const fs=require('node:fs');
  const extract=(file,start,end)=>{const source=fs.readFileSync(file,'utf8');return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));};
  const code=extract('admin.html','        function renderUsersTable','// Toggle Pause Widget')+extract('admin.html','        function showToast','        // Logout')+extract('dashboard.html','        async function updateUsageAndQueries','// Initialize dashboard UI once');
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>ClarityCart XSS test</title><h1>XSS regression test</h1><p>Real production rendering functions; synthetic malicious input.</p><button id="run">Run XSS check</button><pre id="result">Ready</pre><table><tbody id="users-tbody"></tbody></table><div id="queries-container"></div><div id="toast-container"></div><script>'+code+`
   let currentUserSession={user:{email:'test@example.com'}};
   const applyFilters=()=>{};const togglePause=()=>{},confirmBlock=()=>{},confirmDelete=()=>{},openEditModal=()=>{},modifySubscription=()=>{};
   const payload='<img src=x onerror="window.__xss=1"><svg onload="window.__xss=2"></svg>';
   const fetchAccount=async()=>({query_count:1,query_limit:500,period_start:new Date().toISOString(),period_end:new Date(Date.now()+86400000).toISOString(),access_until:new Date(Date.now()+86400000).toISOString()});
   const supabaseClient={from:()=>({select:()=>({eq:async()=>({data:[{question_text:payload}],count:1,error:null})})})};
   document.getElementById('run').onclick=async()=>{window.__xss=0;renderUsersTable([{id:'test',email:payload,store_domain:payload,plan:payload,query_count:0,query_limit:0}]);showToast(payload);await updateUsageAndQueries('test',500,'Starter',false);setTimeout(()=>document.getElementById('result').textContent=JSON.stringify({PASS:window.__xss===0&&document.querySelectorAll('img,[onerror],[onload]').length===0,executed:window.__xss,attackElements:document.querySelectorAll('img,[onerror],[onload]').length,literalText:document.querySelector('[data-safe-field="email"]').textContent===payload},null,2),100)};
  `+'</script>');
 });
 app.get('/',(req,res)=>res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>ClarityCart integration test</title>
 <style>body{font:16px system-ui;max-width:850px;margin:30px auto;background:#eee;color:#111}button{padding:12px;margin:8px}pre{white-space:pre-wrap}</style>
 <h1>ClarityCart isolated integration test</h1><p>Synthetic AI and local PGlite. No live Supabase or paid AI calls.</p>
 <script type="application/ld+json">{"@type":"Product","name":"Test product","description":"Verified test attribute: material is aluminum.","offers":{"price":"25","priceCurrency":"USD"}}</script>
 <button id="add-to-cart">Add to cart</button>
 <script>window.ClarityCartConfig={activeTier:'Starter',tone:'friendly',use_emojis:false,mockMode:false,themePreset:'classic',previewAccessToken:'synthetic-owner-token'};</script>
 <script src="/clarity.js" data-domain="integration.test" data-api="/api/chat"></script>
 <h2>Transport checks</h2><button id="replay">Run replay check</button><button id="race">Run quota race</button><button id="state">Read database state</button><pre id="result">Ready</pre>
 <script>
 const output=document.getElementById('result');
 const state=async()=>await(await fetch('/test/state')).json();
 let token;
 const send=async(body)=>{token ||= (await(await fetch('/api/widget-session',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-owner-token'},body:JSON.stringify({domain:'integration.test'})})).json()).widget_session;return await(await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Widget '+token},body:JSON.stringify(body)})).json();};
 const body=()=>({request_id:crypto.randomUUID(),domain:'integration.test',question:'Known facts?',productContext:{title:'Test',description:'Verified test attribute: material is aluminum.'}});
 document.getElementById('state').onclick=async()=>output.textContent=JSON.stringify(await state(),null,2);
 document.getElementById('replay').onclick=async()=>{const b=body(),before=await state(),first=await send(b),second=await send(b),after=await state();output.textContent=JSON.stringify({test:'replay',PASS:first.usageRecorded&&JSON.stringify(first)===JSON.stringify(second)&&after.rows===before.rows+1,before,after,first,second},null,2)};
 document.getElementById('race').onclick=async()=>{const before=await state(),results=await Promise.all(Array.from({length:12},()=>send(body()))),after=await state();output.textContent=JSON.stringify({test:'quota race',PASS:after.usage===3&&after.rows===3&&after.reserved===0,before,after,accepted:results.filter(x=>x.usageRecorded).length,blocked:results.filter(x=>x.limitReached).length},null,2)};
 </script></html>`));
 const server=app.listen(0,'127.0.0.1',()=>console.log('INTEGRATION_URL=http://127.0.0.1:'+server.address().port));
 process.on('SIGINT',()=>{server.close();pg.close().then(()=>process.exit(0));});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
