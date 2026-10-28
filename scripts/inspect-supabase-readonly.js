const fs=require('fs');const e=require('dotenv').parse(fs.readFileSync('.env'));
(async()=>{
 const base=e.SUPABASE_URL.replace(/\/+$/,'');
 const headers={apikey:e.SUPABASE_SERVICE_KEY,Authorization:'Bearer '+e.SUPABASE_SERVICE_KEY};
 const response=await fetch(base+'/rest/v1/',{headers:{...headers,Accept:'application/openapi+json'},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('Schema read HTTP '+response.status);
 const schema=await response.json();
 const count=await fetch(base+'/rest/v1/questions?select=id&limit=0',{headers:{...headers,Prefer:'count=exact'},signal:AbortSignal.timeout(15000)});
 // No question text, credentials, or personal data is printed/saved.
 console.log(JSON.stringify({project:new URL(base).hostname.split('.')[0],questions:schema.definitions?.questions,
 tables:Object.keys(schema.definitions||{}),rpcs:Object.keys(schema.paths||{}).filter(x=>x.startsWith('/rpc/')),
 countStatus:count.status,count:count.headers.get('content-range'),unverified:['identity/default id','RLS policies','triggers','full constraints']},null,2));
})().catch(e=>{console.error(JSON.stringify({error:e.name,causeCode:e.cause?.code}));process.exitCode=1;});
