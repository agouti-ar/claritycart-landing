const { createClient } = require('@supabase/supabase-js');
function serverDb() {
  return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
}
async function storeForOwner(db,ownerId,storeId) {
  let query=db.from('cc_stores').select('*').eq('owner_id',ownerId);
  if(storeId) query=query.eq('id',storeId);
  const {data,error}=await query.order('created_at').limit(1).maybeSingle();
  if(error) throw error;
  return data;
}
async function snapshot(db,storeId) {
  const {data,error}=await db.rpc('get_cc_store_snapshot',{p_store_id:storeId});
  if(error) throw error;
  return data;
}
function validatedPatch(body,store,admin=false) {
  const patch={};
  const allowed=admin?['store_domain','plan','query_limit','days_to_add','pause']:['store_domain','settings','cancel_at_period_end'];
  if(Object.keys(body).some(key=>!allowed.includes(key))) throw new Error('Unsupported account field');
  if(body.store_domain!==undefined) {
    const domain=String(body.store_domain).trim().toLowerCase();
    if(!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(domain))throw new Error('Invalid domain');
    patch.domain=domain;
  }
  if(body.settings!==undefined) {
    if(!body.settings||typeof body.settings!=='object'||Array.isArray(body.settings))throw new Error('Invalid settings');
    const settings={...store.settings};
    for(const [key,value] of Object.entries(body.settings)) {
      if(['friendly_tone','use_emojis','white_label','exit_intent','intent_discount_enabled'].includes(key)) {if(typeof value!=='boolean')throw new Error('Invalid setting');}
      else if(key==='widget_color') {if(!/^#[a-f0-9]{6}$/i.test(value))throw new Error('Invalid color');}
      else if(key==='theme_preset') {if(!['classic','neon_pop'].includes(value))throw new Error('Invalid theme');}
      else if(key==='tone') {if(!['friendly','professional','sales','custom'].includes(value))throw new Error('Invalid tone');}
      else if(['custom_tone_prompt','promo_code','discount_amount'].includes(key)) {if(typeof value!=='string'||value.length>1000)throw new Error('Invalid setting');}
      else throw new Error('Unsupported setting');
      settings[key]=value;
    }
    patch.settings=settings;
  }
  if(body.cancel_at_period_end!==undefined) {
    if(typeof body.cancel_at_period_end!=='boolean')throw new Error('Invalid cancellation flag');
    if(store.billing_source==='paddle')throw new Error('Paddle cancellation requires the billing integration');
    patch.cancel_at_period_end=body.cancel_at_period_end;
  }
  if(admin) {
    if(body.plan!==undefined) {const plan=String(body.plan).toLowerCase();if(!['starter','pro','business'].includes(plan))throw new Error('Invalid plan');patch.plan=plan;}
    if(body.query_limit!==undefined) {if(!Number.isInteger(body.query_limit)||body.query_limit<0)throw new Error('Invalid limit');patch.quota_override=body.query_limit;}
    if(body.pause!==undefined) {if(typeof body.pause!=='boolean')throw new Error('Invalid pause');patch.status=body.pause?'paused':'active';}
    if(body.days_to_add!==undefined) {
      if(!Number.isInteger(body.days_to_add)||Math.abs(body.days_to_add)>3650)throw new Error('Invalid days');
      const until=new Date(Math.max(Date.now(),new Date(store.access_until).getTime())+body.days_to_add*86400000);
      patch.access_until=new Date(Math.max(new Date(store.access_start).getTime(),until.getTime())).toISOString();
    }
  }
  return patch;
}
async function updateOwnedStore(db,ownerId,body,admin=false,storeId) {
  const store=await storeForOwner(db,ownerId,storeId);
  if(!store)throw new Error('Store is not provisioned');
  const patch=validatedPatch(body,store,admin);
  const {data,error}=await db.from('cc_stores').update(patch).eq('id',store.id).eq('owner_id',ownerId).select().single();
  if(error)throw error;
  return data;
}
function createAccountHandler(options={}) {
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(!['GET','PATCH'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
    try {
      const db=options.db||serverDb();
      const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
      if(!token)return res.status(401).json({error:'AUTH_REQUIRED'});
      const {data,error}=await db.auth.getUser(token);
      if(error||!data?.user)return res.status(401).json({error:'INVALID_SESSION'});
      const storeId=req.query?.store_id;
      const store=await storeForOwner(db,data.user.id,storeId);
      if(!store)return res.status(404).json({error:'STORE_NOT_PROVISIONED'});
      if(req.method==='PATCH') {
        try { await updateOwnedStore(db,data.user.id,req.body||{},false,store.id); }
        catch(error){return res.status(400).json({error:'INVALID_ACCOUNT_UPDATE',message:error.message});}
      }
      return res.status(200).json(await snapshot(db,store.id));
    } catch(error) {
      console.warn('[Account] Protected store data unavailable:',error.code||error.name);
      return res.status(503).json({error:'ACCOUNT_UNAVAILABLE'});
    }
  };
}
module.exports={serverDb,storeForOwner,snapshot,validatedPatch,updateOwnedStore,createAccountHandler};
