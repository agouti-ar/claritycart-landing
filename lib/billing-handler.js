const {serverDb,storeForOwner}=require('./store-access');
const {BillingError,id,uuid,environment,priceConfig,paddleClient,validatePrice,verifySignature,normalizeEvent}=require('./paddle');
function createBillingHandlers(options={}){
 const env=options.env||process.env;
 const rpc=async(db,action,input)=>{const {data,error}=await db.rpc('cc_billing_operation',{p_action:action,p_input:input}).abortSignal(AbortSignal.timeout(4000));if(error)throw new BillingError(503,'BILLING_DATABASE_UNAVAILABLE');if(data?.error)throw new BillingError(data.error==='STORE_NOT_FOUND'?404:409,data.error);return data;};
 const webhook=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  try{
   const mode=environment(env);verifySignature(req.body,req.headers['paddle-signature'],env.PADDLE_WEBHOOK_SECRET,options.now?.()||Date.now());
   let body;try{body=JSON.parse(req.body.toString('utf8'));}catch{throw new BillingError(400,'INVALID_WEBHOOK_JSON');}
   const event=normalizeEvent(body,req.body,mode);if(!event)return res.json({received:true,ignored:true});
   const db=options.db||serverDb();const {data,error}=await db.rpc('apply_cc_paddle_event',{p_event:event}).abortSignal(AbortSignal.timeout(4000));
   if(error){console.warn('[Paddle webhook] Persistence unavailable:',error.code||error.name);throw new BillingError(503,'WEBHOOK_RETRY_REQUIRED');}
   return res.json({received:true,...data});
  }catch(e){return res.status(e.status||503).json({error:e.code||'WEBHOOK_UNAVAILABLE'});}
 };
 const api=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{
   const db=options.db||serverDb();const bearer=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];if(!bearer)throw new BillingError(401,'AUTH_REQUIRED');
   const auth=await db.auth.getUser(bearer);if(auth.error||!auth.data?.user)throw new BillingError(401,'INVALID_SESSION');
   const action=(req.path||new URL(req.url,'http://local').pathname).split('/').pop();
   if(!['status','checkout','cancel','undo-cancel','plan'].includes(action))throw new BillingError(404,'NOT_FOUND');
   if(req.method!==(action==='status'?'GET':'POST'))throw new BillingError(405,'METHOD_NOT_ALLOWED');
   const body=req.method==='GET'?req.query:req.body;
   if(!body||typeof body!=='object'||Array.isArray(body)||!uuid(body.store_id))throw new BillingError(400,'STORE_REQUIRED');
   const allowed=action==='checkout'?['store_id','request_id','plan','interval']:action==='plan'?['store_id','plan','interval']:['store_id'];
   if(Object.keys(body).some(k=>!allowed.includes(k)))throw new BillingError(400,'UNSUPPORTED_BILLING_FIELD');
   const owner=auth.data.user.id;const store=await storeForOwner(db,owner,body.store_id);if(!store)throw new BillingError(404,'STORE_NOT_FOUND');
   const input={owner_id:owner,store_id:store.id,...(uuid(body.request_id)?{request_id:body.request_id}:{})};
   const state=await rpc(db,'inspect',input);
   if(action==='status')return res.json({store_id:store.id,trial_available:state.trial_available,open_checkout:state.open_checkout?{status:state.open_checkout.status,plan:state.open_checkout.plan,interval:state.open_checkout.billing_interval,checkout_url:state.open_checkout.checkout_url,transaction_id:state.open_checkout.transaction_id}:null,subscription:state.subscription?{
    id:state.subscription.id,status:state.subscription.status,price_id:state.subscription.price_id,period_start:state.subscription.period_start,period_end:state.subscription.period_end,trial_end:state.subscription.trial_end,scheduled_cancel:state.subscription.scheduled_cancel,environment:state.subscription.environment
   }:null});
   const paddle=options.paddle||paddleClient({env,fetch:options.fetch});
   if(action==='checkout'){
    if(!uuid(body.request_id))throw new BillingError(400,'REQUEST_ID_REQUIRED');
    if(!['starter','pro','business'].includes(body.plan)||!['month','year'].includes(body.interval))throw new BillingError(400,'INVALID_PLAN');
    const existing=state.request_checkout;
    if(existing){if(existing.plan!==body.plan||existing.billing_interval!==body.interval||existing.store_id!==store.id)throw new BillingError(409,'CHECKOUT_CONFLICT');if(existing.status==='ready'||existing.status==='completed')return res.json({transaction_id:existing.transaction_id,checkout_url:existing.checkout_url,status:existing.status});throw new BillingError(409,existing.status==='creating'?'CHECKOUT_PENDING_RECONCILIATION':'CHECKOUT_FAILED_USE_NEW_REQUEST');}
    if(state.open_checkout){const c=state.open_checkout;if(c.status==='ready'&&c.plan===body.plan&&c.billing_interval===body.interval)return res.json({transaction_id:c.transaction_id,checkout_url:c.checkout_url,status:c.status});throw new BillingError(409,c.status==='creating'?'CHECKOUT_PENDING_RECONCILIATION':'CHECKOUT_ALREADY_OPEN');}
    const price=priceConfig(body.plan,body.interval,state.trial_available,env);validatePrice(await paddle('/prices/'+price.price_id),price);await rpc(db,'register_price',price);
    const prepared=await rpc(db,'prepare',{...input,...price});const c=prepared.checkout;
    if(!prepared.created){if(c.status==='ready'||c.status==='completed')return res.json({transaction_id:c.transaction_id,checkout_url:c.checkout_url,status:c.status});throw new BillingError(409,'CHECKOUT_PENDING_RECONCILIATION');}
    let checkoutBase;try{checkoutBase=new URL(env.PADDLE_CHECKOUT_URL);if(checkoutBase.protocol!=='https:'||checkoutBase.username||checkoutBase.password||checkoutBase.search||checkoutBase.hash)throw new Error();}catch{
     await rpc(db,'finish',{...input,checkout_id:c.id,failed:true});throw new BillingError(503,'PADDLE_CHECKOUT_URL_INVALID');
    }
    let transaction;
    try{transaction=await paddle('/transactions',{method:'POST',body:{items:[{price_id:price.price_id,quantity:1}],collection_mode:'automatic',custom_data:{claritycart_checkout_id:c.id},checkout:{url:checkoutBase.href}}});}
    catch(e){if(e.definite)await rpc(db,'finish',{...input,checkout_id:c.id,failed:true});throw e;}
    let url;try{url=new URL(transaction.checkout?.url);if(!id('txn',transaction.id)||url.origin!==checkoutBase.origin||url.searchParams.get('_ptxn')!==transaction.id)throw new Error();}catch{throw new BillingError(503,'CHECKOUT_PENDING_RECONCILIATION');}
    await rpc(db,'finish',{...input,checkout_id:c.id,transaction_id:transaction.id,checkout_url:url.href});
    return res.json({transaction_id:transaction.id,checkout_url:url.href,status:'ready',trial_days:price.trial_days});
   }
   const sub=state.subscription;
   if(!sub||sub.status==='canceled')throw new BillingError(409,'SUBSCRIPTION_NOT_ACTIVE');
   if(sub.environment!==environment(env))throw new BillingError(409,'BILLING_ENVIRONMENT_MISMATCH');
   if(action==='cancel')await paddle('/subscriptions/'+sub.id+'/cancel',{method:'POST',body:{effective_from:'next_billing_period'}});
   else if(action==='undo-cancel'){
    if(!sub.scheduled_cancel)throw new BillingError(409,'NO_SCHEDULED_CANCELLATION');
    await paddle('/subscriptions/'+sub.id,{method:'PATCH',body:{scheduled_change:null}});
   }else if(action==='plan'){
    if(!['active','trialing'].includes(sub.status))throw new BillingError(409,'SUBSCRIPTION_NOT_CHANGEABLE');
    const price=priceConfig(body.plan,body.interval,false,env);validatePrice(await paddle('/prices/'+price.price_id),price);await rpc(db,'register_price',price);
    await paddle('/subscriptions/'+sub.id,{method:'PATCH',body:{items:[{price_id:price.price_id,quantity:1}],proration_billing_mode:sub.status==='trialing'?'do_not_bill':'prorated_immediately',on_payment_failure:'prevent_change'}});
   }
   return res.status(202).json({accepted:true,pending_webhook:true});
  }catch(e){return res.status(e.status||503).json({error:e.code||'BILLING_UNAVAILABLE'});}
 };
 return {api,webhook};
}
module.exports={createBillingHandlers};
