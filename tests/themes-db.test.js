const {test,before,after}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {createTestDb}=require('./helpers/test-db');const {createApp}=require('../server');const {createAccountHandler}=require('../lib/store-access');const {createConfigHandler}=require('../api/config');const {createDetectColorHandler}=require('../lib/detect-color');
let pg,db,server,base,store;const owner=randomUUID(),stranger=randomUUID(),secret='color-test-secret-'.repeat(4);let fetches=0;
const transport={lookup:async()=>[{address:'93.184.216.34',family:4}],request:(url,opts,callback)=>{fetches++;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const res=new PassThrough();res.socket={remoteAddress:'93.184.216.34'};res.statusCode=200;res.headers={'content-type':'text/html'};callback(res);res.end('<meta name="theme-color" content="#abcdef">');});return req;}};
before(async()=>{
 ({pg,db}=await createTestDb({security:true,freezeRateClock:true}));await pg.query('insert into auth.users(id) values($1),($2)',[owner,stranger]);
 store=(await pg.query("insert into public.cc_stores(owner_id,domain,plan,status,access_until,settings) values($1,'themes.example.com','pro','active',now()+interval '30 days',$2) returning *",[owner,JSON.stringify({promo_code:'KEEP',white_label:true})])).rows[0];
 db.auth={getUser:async token=>({data:{user:token==='owner'?{id:owner,email:'merchant@example.com'}:token==='other'?{id:stranger,email:'other@example.com'}:null},error:null})};
 const app=createApp({db,colorOptions:{...transport,secret}});server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await pg?.close();});
async function run(handler,req){const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;return this;},end(){return this;}};await handler(req,res);return res;}
test('PGlite owner settings roundtrip: four presets, legacy alias, custom color/reset and public config',async()=>{
 const account=createAccountHandler({db}),config=createConfigHandler({db});
 for(const theme_preset of ['classic','solar_graphite','mint_lavender','berry_coral','neon_pop'])for(const widget_color of ['#123456',null]){
  const saved=await run(account,{method:'PATCH',headers:{authorization:'Bearer owner'},query:{store_id:store.id},body:{settings:{theme_preset,widget_color}}});assert.equal(saved.code,200);assert.equal(saved.body.settings.promo_code,'KEEP');
  const publicResult=await run(config,{method:'GET',query:{domain:store.domain}});assert.equal(publicResult.body.theme_preset,widget_color ? 'classic' : theme_preset);assert.equal(publicResult.body.widget_color,widget_color);
 }
 const saved=(await pg.query('select settings from public.cc_stores where id=$1',[store.id])).rows[0].settings;assert.equal(saved.theme_preset,'neon_pop');assert.equal(saved.widget_color,null);assert.equal(saved.white_label,true);
});
test('Local HTTP and CommonJS Vercel handler share detection and reject anonymous/foreign/malformed callers',async()=>{
 assert.equal(typeof require('../api/detect-color'),'function');const handler=createDetectColorHandler({db,...transport,secret});const query={domain:store.domain,store_id:store.id};
 const direct=await run(handler,{method:'GET',query,headers:{authorization:'Bearer owner'}});assert.equal(direct.code,200);assert.deepEqual(direct.body,{detected:true,source:'meta_theme_color',color:'#ABCDEF'});
 const url=base+'/api/detect-color?'+new URLSearchParams(query);const http=await fetch(url,{headers:{Authorization:'Bearer owner'}});assert.equal(http.status,200);assert.deepEqual(await http.json(),direct.body);
 const before=fetches;for(const [token,q,expected]of [['',query,401],['other',query,403],['owner',{...query,domain:'foreign.example.com'},403],['owner',{...query,store_id:'bad'},400],['owner',{...query,domain:'127.0.0.1'},400]]){const r=await run(handler,{method:'GET',query:q,headers:token?{authorization:'Bearer '+token}:{}});assert.equal(r.code,expected);}
 assert.equal(fetches,before);assert.equal((await fetch(url,{method:'POST'})).status,405);assert.equal((await fetch(url,{method:'OPTIONS'})).status,204);
});
test('persisted rate limiter denies eleventh owner fetch before outbound HTTP; plan cannot be forged',async()=>{
 const handler=createDetectColorHandler({db,...transport,secret}),req={method:'GET',query:{domain:store.domain,store_id:store.id},headers:{authorization:'Bearer owner'}};
 // Two accepted requests above consumed two slots in the frozen rate window.
 for(let i=0;i<8;i++)assert.equal((await run(handler,req)).code,200);
 const before=fetches;assert.equal((await run(handler,req)).code,429);assert.equal(fetches,before);
 await pg.query("update public.cc_stores set plan='starter' where id=$1",[store.id]);assert.equal((await run(handler,{...req,query:{...req.query,plan:'business'}})).code,403);
 await pg.query("update public.cc_stores set plan='pro',access_until=now()-interval '1 day',access_start=now()-interval '2 days' where id=$1",[store.id]);assert.equal((await run(handler,req)).code,403);
});
