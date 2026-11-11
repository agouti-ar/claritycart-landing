const {serverDb,storeForOwner}=require('./store-access');
const {RequestError,rate}=require('./request-security');
const {documentInput}=require('./grounding');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function createKnowledgeHandler(options={}){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(!['GET','POST'].includes(req.method))throw new RequestError(405,'METHOD_NOT_ALLOWED');
  const db=options.db||serverDb();const token=(req.headers?.authorization||'').match(/^Bearer (.+)$/)?.[1];if(!token)throw new RequestError(401,'AUTH_REQUIRED');
  const auth=await db.auth.getUser(token);if(auth.error||!auth.data?.user)throw new RequestError(401,'INVALID_SESSION');
  const body=req.method==='GET'?req.query:req.body;
  if(!body||!uuid(body.store_id))throw new RequestError(400,'STORE_REQUIRED');
  const owned=await storeForOwner(db,auth.data.user.id,body.store_id);if(!owned)throw new RequestError(404,'STORE_NOT_FOUND');
  let doc=null,expected=null,expires=null;
  if(req.method==='POST'){
   if(Object.keys(body).some(k=>!['store_id','document','expected_revision','expires_at'].includes(k))||Buffer.byteLength(JSON.stringify(body))>24576)throw new RequestError(400,'INVALID_KNOWLEDGE_INPUT');
   if(body.expected_revision!==undefined&&body.expected_revision!==null&&!uuid(body.expected_revision))throw new RequestError(400,'INVALID_REVISION');
   expected=body.expected_revision||null;expires=body.expires_at===undefined?new Date(Date.now()+7*86400000).toISOString():body.expires_at;
   if(typeof expires!=='string'||!Number.isFinite(new Date(expires).getTime())||new Date(expires)<=new Date()||new Date(expires)>new Date(Date.now()+30*86400000))throw new RequestError(400,'INVALID_EXPIRATION');
   try{doc=documentInput(body.document,owned.domain);}catch(error){throw new RequestError(400,error.message);}
   await rate(db,'knowledge:owner:'+auth.data.user.id,10,options.secret);
  }
  const {data,error}=await db.rpc('manage_cc_knowledge',{p_store_id:owned.id,p_owner_id:auth.data.user.id,p_document:doc,p_expected:expected,p_expires:expires}).abortSignal(AbortSignal.timeout(4000));
  if(error)throw error;if(data?.error)throw new RequestError(data.error==='KNOWLEDGE_REVISION_CONFLICT'?409:403,data.error);
  return res.json(data);
 }catch(error){return res.status(error.status||503).json({error:error.status?error.code:'KNOWLEDGE_UNAVAILABLE'});}
};}
module.exports={createKnowledgeHandler};
