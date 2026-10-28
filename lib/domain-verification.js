const {resolveTxt}=require('node:dns/promises');
const {serverDb,storeForOwner}=require('./store-access');
function createDomainVerificationHandler(options={}){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
 try{
  const db=options.db||serverDb();const token=(req.headers?.authorization||'').match(/^Bearer (.+)$/)?.[1];
  if(!token)return res.status(401).json({error:'AUTH_REQUIRED'});
  const {data,error}=await db.auth.getUser(token);if(error||!data?.user)return res.status(401).json({error:'INVALID_SESSION'});
  const store=await storeForOwner(db,data.user.id,req.query?.store_id);if(!store)return res.status(404).json({error:'STORE_NOT_PROVISIONED'});
  const name='_claritycart-verification.'+store.domain,value='claritycart='+store.domain_verification_token;
  if(req.method==='GET')return res.json({name,value,verified:!!store.domain_verified_at});
  let timer;let records;
  try{records=await Promise.race([(options.resolveTxt||resolveTxt)(name),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('DNS_TIMEOUT')),5000);})]);}
  catch{return res.status(409).json({error:'DNS_RECORD_NOT_CONFIRMED'});}finally{clearTimeout(timer);}
  if(!records.some(parts=>parts.join('')===value))return res.status(409).json({error:'DNS_RECORD_NOT_CONFIRMED'});
  // Compare domain and challenge too: a concurrent domain edit must not be verified by stale DNS.
  const result=await db.from('cc_stores').update({domain_verified_at:new Date().toISOString()}).eq('id',store.id).eq('owner_id',data.user.id).eq('domain',store.domain).eq('domain_verification_token',store.domain_verification_token).select().maybeSingle();
  if(result.error)throw result.error;if(!result.data)return res.status(409).json({error:'DOMAIN_CHANGED'});
  return res.json({verified:true});
 }catch{return res.status(503).json({error:'VERIFICATION_UNAVAILABLE'});}
};}
module.exports={createDomainVerificationHandler};
