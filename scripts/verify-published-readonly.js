// GET-only deployment probe. No credentials, writes, AI generation or session minting.
const {readFileSync,writeFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const base='https://claritycart-landing.vercel.app';
const hash=value=>createHash('sha256').update(value).digest('hex');
(async()=>{
 const checks=[];
 for(const path of ['/','/clarity.js','/api/health','/api/account','/api/admin/overview','/api/widget-session','/api/verify-domain','/api/live-sync','/server.js','/lib/request-security.js']){
  try{
   const response=await fetch(base+path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000)});
   const check={path,status:response.status,contentType:response.headers.get('content-type')};
   if(path==='/'||path==='/clarity.js'){
    const bytes=Buffer.from(await response.arrayBuffer());
    check.sha256=hash(bytes);check.matchesWorkingTree=check.sha256===hash(readFileSync(path==='/'?'index.html':'clarity.js'));
   }else await response.body?.cancel();
   checks.push(check);
  }catch(error){checks.push({path,error:error.name,causeCode:error.cause?.code});}
 }
 const report={checkedAt:new Date().toISOString(),deployment:base,method:'Unauthenticated GET only',checks,
  notVerified:['deployed commit identity','authenticated ownership and admin actions','database writes and quota concurrency','AI generation','Vercel forwarded IP behavior','webhook delivery']};
 writeFileSync('docs/published-readonly-check.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
 if(checks.some(c=>c.error))process.exitCode=1;
})().catch(error=>{console.error(error.name);process.exitCode=1;});
