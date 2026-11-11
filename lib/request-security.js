const {createHmac,timingSafeEqual}=require('node:crypto');
const {isIP}=require('node:net');
const {serverDb}=require('./store-access');
class RequestError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
function secretKey(value=process.env.WIDGET_SESSION_SECRET){if(typeof value!=='string'||value.length<32)throw new RequestError(503,'WIDGET_SESSION_NOT_CONFIGURED');return value;}
function originOf(req){const value=req.headers?.origin;if(typeof value!=='string'||value.length>512)throw new RequestError(403,'ORIGIN_REQUIRED');try{const u=new URL(value);if(u.origin!==value||!['https:','http:'].includes(u.protocol))throw new Error();return u;}catch{throw new RequestError(403,'INVALID_ORIGIN');}}
function clientIp(req,vercel=process.env.VERCEL==='1'){
 const value=vercel?req.headers?.['x-vercel-forwarded-for']:req.socket?.remoteAddress;
 if(typeof value!=='string'||!isIP(value))throw new RequestError(503,'CLIENT_IP_UNAVAILABLE');
 return value.startsWith('::ffff:')&&isIP(value.slice(7))===4?value.slice(7):value;
}
function signSession(payload,secret){const data=Buffer.from(JSON.stringify(payload)).toString('base64url');return data+'.'+createHmac('sha256',secretKey(secret)).update(data).digest('base64url');}
function verifySession(token,secret,now=Date.now()){
 if(typeof token!=='string'||token.length>2048)throw new RequestError(401,'INVALID_WIDGET_SESSION');
 const [data,signature,...extra]=token.split('.');if(extra.length||!data||!/^[a-zA-Z0-9_-]{43}$/.test(signature||''))throw new RequestError(401,'INVALID_WIDGET_SESSION');
 const expected=createHmac('sha256',secretKey(secret)).update(data).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature,'base64url')))throw new RequestError(401,'INVALID_WIDGET_SESSION');
 let p;try{p=JSON.parse(Buffer.from(data,'base64url').toString());}catch{throw new RequestError(401,'INVALID_WIDGET_SESSION');}
 if(p.v!==1||!['storefront','preview'].includes(p.kind)||typeof p.sid!=='string'||!Number.isInteger(p.epoch)||!Number.isInteger(p.exp)||p.exp*1000<=now||p.exp*1000>now+301000)throw new RequestError(401,'EXPIRED_WIDGET_SESSION');
 return p;
}
function cors(req,res){res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Origin');try{res.setHeader('Access-Control-Allow-Origin',originOf(req).origin);}catch{}res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');}
async function rate(db,bucket,limit,secret){
 const hash=createHmac('sha256',secretKey(secret)).update(bucket).digest('hex');
 const {data,error}=await db.rpc('consume_cc_rate_limit',{p_bucket:hash,p_limit:limit,p_window_seconds:60}).abortSignal(AbortSignal.timeout(5000));
 if(error)throw new RequestError(503,'RATE_LIMIT_UNAVAILABLE');if(!data?.allowed)throw new RequestError(429,'RATE_LIMITED');
}
function adminEmails(){return (process.env.ADMIN_EMAILS||'darksteel180@gmail.com,lordlymonk@gmail.com').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);}
function validateChatBody(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new RequestError(400,'INVALID_REQUEST');
 let serialized;try{serialized=JSON.stringify(body);}catch{throw new RequestError(400,'INVALID_REQUEST');}
 if(Buffer.byteLength(serialized)>32768)throw new RequestError(413,'INPUT_TOO_LARGE');
 if(typeof body.question!=='string'||!body.question.trim()||body.question.length>2000)throw new RequestError(400,'INVALID_QUESTION');
 if(body.productContext!==undefined&&(!body.productContext||typeof body.productContext!=='object'||Array.isArray(body.productContext)))throw new RequestError(400,'INVALID_CONTEXT');
 for(const [key,max] of [['title',500],['description',16000],['price',100]]){const value=body.productContext?.[key];if(value!==undefined&&(typeof value!=='string'||value.length>max))throw new RequestError(400,'INVALID_CONTEXT');}
 if(body.history!==undefined&&(!Array.isArray(body.history)||body.history.length>6||body.history.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>1000||Object.keys(m).some(k=>!['role','text'].includes(k)))))throw new RequestError(400,'INVALID_HISTORY');
 const stack=[[body,0]];let nodes=0;
 while(stack.length){const [value,depth]=stack.pop();if(++nodes>1024||depth>8)throw new RequestError(400,'INPUT_TOO_COMPLEX');if(value&&typeof value==='object')for(const child of Object.values(value))stack.push([child,depth+1]);}
 if(body.temperature!==undefined&&(!Number.isFinite(body.temperature)||body.temperature<0||body.temperature>1))throw new RequestError(400,'INVALID_TEMPERATURE');
}
async function authorizeWidget(req,db,options={}){
 const secret=secretKey(options.secret);const origin=originOf(req);
 const token=(req.headers?.authorization||'').match(/^Widget (.+)$/)?.[1];const p=verifySession(token,secret);
 if(p.origin!==origin.origin)throw new RequestError(403,'ORIGIN_MISMATCH');
 const {data:store,error}=await db.from('cc_stores').select('*').eq('id',p.sid).maybeSingle();
 if(error)throw new RequestError(503,'STORE_UNAVAILABLE');
 const domain=String(req.body?.domain||req.body?.store_domain||'').trim().toLowerCase();
 if(!store||store.domain!==domain||store.widget_epoch!==p.epoch)throw new RequestError(403,'STORE_MISMATCH');
 if(p.kind==='storefront'){
  if(!store.domain_verified_at||origin.protocol!=='https:'||origin.hostname!==store.domain||origin.port)throw new RequestError(403,'UNVERIFIED_STOREFRONT');
 }else if(p.uid!==store.owner_id&&!p.developer)throw new RequestError(403,'STORE_OWNER_MISMATCH');
 const events=options.purpose==='events';
 await rate(db,(events?'events:ip:':'chat:ip:')+clientIp(req,options.vercel),events?60:30,secret);
 await rate(db,(events?'events:store:':'chat:store:')+store.id,events?300:120,secret);
 return {storeId:store.id,epoch:p.epoch,kind:p.kind,developer:p.kind==='preview'&&p.developer===true};
}
function createWidgetSessionHandler(options={}){return async(req,res)=>{
 cors(req,res);if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
 try{
  const db=options.db||serverDb();const secret=secretKey(options.secret);const origin=originOf(req);const domain=String(req.body?.domain||'').trim().toLowerCase();
  if(!domain||domain.length>253)throw new RequestError(400,'STORE_REQUIRED');
  await rate(db,'session:ip:'+clientIp(req,options.vercel),30,secret);
  const {data:store,error}=await db.from('cc_stores').select('*').eq('domain',domain).maybeSingle();if(error)throw new RequestError(503,'STORE_UNAVAILABLE');if(!store)throw new RequestError(404,'UNKNOWN_STORE');
  let kind='storefront',uid,developer=false;
  const bearer=(req.headers?.authorization||'').match(/^Bearer (.+)$/)?.[1];
  if(bearer){
   const {data,error}=await db.auth.getUser(bearer);if(error||!data?.user)throw new RequestError(401,'INVALID_SESSION');
   developer=adminEmails().includes(String(data.user.email||'').toLowerCase());uid=data.user.id;
   if(uid!==store.owner_id&&!developer)throw new RequestError(403,'STORE_OWNER_MISMATCH');
   if(origin.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(origin.hostname))throw new RequestError(403,'INSECURE_PREVIEW_ORIGIN');
   kind='preview';
  }else if(!store.domain_verified_at||origin.protocol!=='https:'||origin.hostname!==store.domain||origin.port)throw new RequestError(403,'UNVERIFIED_STOREFRONT');
  const exp=Math.floor(Date.now()/1000)+300;
  const widget_session=signSession({v:1,sid:store.id,origin:origin.origin,epoch:store.widget_epoch,kind,uid,developer,exp},secret);
  return res.status(200).json({widget_session,expires_at:exp,developer});
 }catch(error){return res.status(error.status||503).json({error:error.code||'SESSION_UNAVAILABLE'});}
};}
module.exports={RequestError,validateChatBody,authorizeWidget,createWidgetSessionHandler,signSession,verifySession,clientIp,originOf,rate,adminEmails,cors};
