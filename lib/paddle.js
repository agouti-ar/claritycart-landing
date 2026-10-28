const {createHmac,timingSafeEqual,createHash}=require('node:crypto');
class BillingError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
const id=(prefix,value)=>typeof value==='string'&&new RegExp('^'+prefix+'_[a-z0-9]{26}$').test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function environment(env=process.env){const mode=env.PADDLE_ENVIRONMENT||'sandbox';if(!['sandbox','production'].includes(mode))throw new BillingError(503,'BILLING_CONFIGURATION_INVALID');return mode;}
function priceConfig(plan,interval,trial,env=process.env){
 if(!['starter','pro','business'].includes(plan)||!['month','year'].includes(interval))throw new BillingError(400,'INVALID_PLAN');
 const key=`PADDLE_PRICE_${plan.toUpperCase()}_${interval==='month'?'MONTHLY':'YEARLY'}${trial?'_TRIAL':''}`;
 const priceId=env[key];if(!id('pri',priceId))throw new BillingError(503,'BILLING_PRICE_NOT_CONFIGURED');
 const used=[];for(const p of ['STARTER','PRO','BUSINESS'])for(const i of ['MONTHLY','YEARLY'])for(const s of ['','_TRIAL'])if(env[`PADDLE_PRICE_${p}_${i}${s}`]===priceId)used.push(p+i+s);
 if(used.length!==1)throw new BillingError(503,'BILLING_PRICE_MAPPING_AMBIGUOUS');
 return {price_id:priceId,plan,billing_interval:interval,trial_days:trial?7:0,environment:environment(env)};
}
function paddleClient({env=process.env,fetch:request=fetch}={}){
 const mode=environment(env),base=mode==='sandbox'?'https://sandbox-api.paddle.com':'https://api.paddle.com';
 return async(path,{method='GET',body}={})=>{
  if(!env.PADDLE_API_KEY)throw new BillingError(503,'BILLING_NOT_CONFIGURED');
  let r;try{r=await request(base+path,{method,headers:{Authorization:'Bearer '+env.PADDLE_API_KEY,'Content-Type':'application/json','Paddle-Version':'1'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});}catch{throw new BillingError(503,'PADDLE_REQUEST_UNCONFIRMED');}
  let value;try{value=await r.json();}catch{throw new BillingError(503,'PADDLE_INVALID_RESPONSE');}
  if(!r.ok){const e=new BillingError(502,'PADDLE_REQUEST_FAILED');e.definite=r.status>=400&&r.status<500&&![408,409,429].includes(r.status);console.warn('[Paddle]',JSON.stringify({httpStatus:r.status,providerCode:typeof value.error?.code==='string'?value.error.code:undefined}));throw e;}
  if(!value.data)throw new BillingError(503,'PADDLE_INVALID_RESPONSE');return value.data;
 };
}
function validatePrice(data,config){
 const trial=data.trial_period;
 if(data.id!==config.price_id||data.status!=='active'||data.billing_cycle?.interval!==config.billing_interval||data.billing_cycle.frequency!==1||!/^\d+$/.test(data.unit_price?.amount||'')||BigInt(data.unit_price.amount)<=0n)throw new BillingError(503,'PADDLE_PRICE_INVALID');
 if(config.trial_days===7){if(trial?.interval!=='day'||trial.frequency!==7||trial.unit_price&&BigInt(trial.unit_price.amount||'0')!==0n||trial.requires_payment_method===false)throw new BillingError(503,'PADDLE_TRIAL_PRICE_INVALID');}
 else if(trial)throw new BillingError(503,'PADDLE_REGULAR_PRICE_HAS_TRIAL');
 return config;
}
function verifySignature(raw,header,secret,now=Date.now()){
 if(!secret)throw new BillingError(503,'PADDLE_WEBHOOK_NOT_CONFIGURED');
 if(!Buffer.isBuffer(raw)||raw.length>262144)throw new BillingError(400,'RAW_BODY_REQUIRED');
 if(typeof header!=='string'||header.length>2048)throw new BillingError(401,'INVALID_PADDLE_SIGNATURE');
 const parts=header.split(';').map(s=>s.trim().split('='));const times=parts.filter(p=>p[0]==='ts'),hashes=parts.filter(p=>p[0]==='h1').map(p=>p[1]);
 if(times.length!==1||!/^\d{1,12}$/.test(times[0][1])||Math.abs(now-Number(times[0][1])*1000)>5000)throw new BillingError(401,'INVALID_PADDLE_SIGNATURE');
 const expected=createHmac('sha256',secret).update(times[0][1]+':').update(raw).digest();
 if(!hashes.some(h=>/^[a-f0-9]{64}$/i.test(h||'')&&timingSafeEqual(expected,Buffer.from(h,'hex'))))throw new BillingError(401,'INVALID_PADDLE_SIGNATURE');
}
function date(value,required=false){if(value==null&&!required)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))throw new BillingError(400,'INVALID_PADDLE_EVENT');return new Date(value).toISOString();}
const subscriptionEvents=new Set(['subscription.created','subscription.updated','subscription.trialing','subscription.activated','subscription.canceled','subscription.paused','subscription.resumed','subscription.past_due']);
const paymentEvents=new Set(['transaction.completed','transaction.paid','transaction.payment_failed']);
function normalizeEvent(body,raw,mode){
 if(!id('evt',body?.event_id)||typeof body.event_type!=='string')throw new BillingError(400,'INVALID_PADDLE_EVENT');
 const base={event_id:body.event_id,type:body.event_type,occurred_at:date(body.occurred_at,true),environment:mode,payload_hash:createHash('sha256').update(raw).digest('hex')};
 if(!subscriptionEvents.has(base.type)&&!paymentEvents.has(base.type))return null;
 const d=body.data,item=d?.items?.[0];
 if(!d||d.collection_mode!=='automatic'||!Array.isArray(d.items)||d.items.length!==1||item.quantity!==1||!id('pri',item.price?.id||item.price_id)||!id('ctm',d.customer_id))throw new BillingError(400,'UNSUPPORTED_PADDLE_SUBSCRIPTION');
 const common={...base,customer_id:d.customer_id,price_id:item.price?.id||item.price_id,updated_at:date(d.updated_at,true),checkout_id:uuid(d.custom_data?.claritycart_checkout_id)?d.custom_data.claritycart_checkout_id:null};
 if(subscriptionEvents.has(base.type)){
  if(!id('sub',d.id)||!['trialing','active','past_due','paused','canceled'].includes(d.status))throw new BillingError(400,'INVALID_PADDLE_EVENT');
  return {...common,kind:'subscription',subscription_id:d.id,transaction_id:id('txn',d.transaction_id)?d.transaction_id:null,status:d.status,started_at:date(d.started_at),first_billed_at:date(d.first_billed_at),period_start:date(d.current_billing_period?.starts_at),period_end:date(d.current_billing_period?.ends_at),trial_start:date(item.trial_dates?.starts_at),trial_end:date(item.trial_dates?.ends_at),scheduled_cancel:d.scheduled_change?.action==='cancel',scheduled_at:date(d.scheduled_change?.effective_at),canceled_at:date(d.canceled_at)};
 }
 if(base.type==='transaction.paid'&&!d.subscription_id)return null;
 if(!id('txn',d.id)||!id('sub',d.subscription_id))throw new BillingError(400,'INVALID_PADDLE_EVENT');
 const amount=d.details?.totals?.total;
 if(base.type==='transaction.completed'&&(d.status!=='completed'||!/^\d+$/.test(amount||'')))throw new BillingError(400,'INVALID_PADDLE_PAYMENT');
 const period=d.billing_period||d.details?.line_items?.[0]?.proration?.billing_period;
 return {...common,kind:'payment',transaction_id:d.id,subscription_id:d.subscription_id,status:base.type==='transaction.completed'?'completed':base.type==='transaction.paid'?'paid':'payment_failed',amount:amount||'0',currency:typeof d.currency_code==='string'?d.currency_code:null,period_start:date(period?.starts_at),period_end:date(period?.ends_at)};
}
module.exports={BillingError,id,uuid,environment,priceConfig,paddleClient,validatePrice,verifySignature,normalizeEvent};
