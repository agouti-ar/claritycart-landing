const {createHmac}=require('node:crypto');
const {serverDb,storeForOwner}=require('./store-access');
const {authorizeWidget,RequestError,cors,adminEmails}=require('./request-security');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function analyticsIdentity(value,storeId,secret=process.env.WIDGET_SESSION_SECRET){
 if(typeof secret!=='string'||secret.length<32)throw new RequestError(503,'ANALYTICS_NOT_CONFIGURED');
 return createHmac('sha256',secret).update(storeId+':'+value).digest('hex');
}
function validateEvents(body){
 if(!body||Array.isArray(body)||typeof body!=='object')throw new RequestError(400,'INVALID_EVENTS');
 if(Buffer.byteLength(JSON.stringify(body))>16384)throw new RequestError(413,'INVALID_EVENTS_SIZE');
 if(Object.keys(body).some(k=>!['domain','visitor_id','session_id','events'].includes(k))||typeof body.domain!=='string'||body.domain.length>253||!uuid(body.visitor_id)||!uuid(body.session_id)||!Array.isArray(body.events)||body.events.length<1||body.events.length>20)throw new RequestError(400,'INVALID_EVENTS');
 const ids=new Set();
 for(const e of body.events){
  if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!['event_id','type','product_path','source'].includes(k))||!uuid(e.event_id)||ids.has(e.event_id.toLowerCase())||!['session_start','product_view','cart_add'].includes(e.type))throw new RequestError(400,'INVALID_EVENT');
  ids.add(e.event_id.toLowerCase());
  if(e.type==='session_start'&&(e.product_path!==undefined||e.source!==undefined))throw new RequestError(400,'INVALID_EVENT');
  if(e.type==='product_view'&&e.source!==undefined)throw new RequestError(400,'INVALID_EVENT');
  if(e.type!=='session_start'&&(typeof e.product_path!=='string'||e.product_path.length>512||!e.product_path.startsWith('/')||/[?#\r\n]/.test(e.product_path)))throw new RequestError(400,'INVALID_PRODUCT_PATH');
  if(e.type==='cart_add'&&!['merchant_confirmed','shopify_ajax','woocommerce_added'].includes(e.source))throw new RequestError(400,'UNCONFIRMED_CART_EVENT');
 }
}
function createEventsHandler(options={}){return async(req,res)=>{
 cors(req,res);res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
 if(req.method==='OPTIONS')return res.status(204).end();
 try{
  const db=options.db||serverDb();
  if(req.method==='GET'){
   const token=(req.headers?.authorization||'').match(/^Bearer (.+)$/)?.[1];if(!token)throw new RequestError(401,'AUTH_REQUIRED');
   const auth=await db.auth.getUser(token);if(auth.error||!auth.data?.user)throw new RequestError(401,'INVALID_SESSION');
   if(!uuid(req.query?.store_id))throw new RequestError(400,'STORE_REQUIRED');
   const store=await storeForOwner(db,auth.data.user.id,req.query.store_id);if(!store)throw new RequestError(404,'STORE_NOT_FOUND');
   const {data,error}=await db.rpc('get_cc_analytics',{p_store_id:store.id,p_owner_id:auth.data.user.id}).abortSignal(AbortSignal.timeout(8000));
   if(error)throw error;if(data?.error)throw new RequestError(403,data.error);
   const advanced=adminEmails().includes(String(auth.data.user.email||'').toLowerCase())||
    (store.plan==='business'&&['active','trialing'].includes(store.status)&&new Date(store.access_until)>new Date());
   return res.json({...data,advanced_available:advanced,...(!advanced?{cart_additions:null,engaged_visitors:null}:{} )});
  }
  if(req.method!=='POST')throw new RequestError(405,'METHOD_NOT_ALLOWED');
  validateEvents(req.body);
  const binding=await authorizeWidget(req,db,{...options,purpose:'events'});
  // Owner/admin previews are intentionally excluded from merchant metrics.
  if(binding.kind==='preview')return res.json({accepted:0,ignored:true});
  const body=req.body;
  const events=body.events.map(e=>({event_id:e.event_id,type:e.type,product_ref:e.product_path?analyticsIdentity(e.product_path,binding.storeId,options.secret):null,source:e.type==='cart_add'?e.source:null}));
  const {data,error}=await db.rpc('ingest_cc_events',{p_store_id:binding.storeId,p_epoch:binding.epoch,p_visitor:analyticsIdentity(body.visitor_id,binding.storeId,options.secret),p_session:body.session_id,p_events:events}).abortSignal(AbortSignal.timeout(8000));
  if(error)throw error;if(data?.error)throw new RequestError(data.error==='EVENT_CONFLICT'?409:403,data.error);
  return res.json(data);
 }catch(error){if(error.status===429)res.setHeader('Retry-After','60');return res.status(error.status||503).json({error:error.code&&error.status?error.code:'ANALYTICS_UNAVAILABLE'});}
};}
module.exports={createEventsHandler,validateEvents,analyticsIdentity,uuid};
