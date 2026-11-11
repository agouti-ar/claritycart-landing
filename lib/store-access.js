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
    const paid=['pro','business'].includes(store.plan);
    if(!paid&&Object.keys(body.settings).some(key=>['tone','custom_instructions','friendly_tone','custom_tone_prompt','exit_intent','intent_discount_enabled','promo_code','discount_amount'].includes(key)))throw new Error('This setting requires Pro or Business');
    if(store.plan!=='business'&&body.settings.white_label===true)throw new Error('White-label requires Business');
    if(!paid&&((body.settings.widget_color!==undefined&&body.settings.widget_color!==null)||(body.settings.theme_preset!==undefined&&body.settings.theme_preset!=='classic')))throw new Error('This setting requires Pro or Business');
    const settings={...store.settings};
    for(const [key,value] of Object.entries(body.settings)) {
      if(['friendly_tone','use_emojis','white_label','exit_intent','intent_discount_enabled'].includes(key)) {if(typeof value!=='boolean')throw new Error('Invalid setting');}
      else if(key==='widget_color') {if(value!==null&&(typeof value!=='string'||!/^#[a-f0-9]{6}$/i.test(value)))throw new Error('Invalid color');}
      else if(key==='theme_preset') {if(!require('../widget-themes').isPreset(value))throw new Error('Invalid theme');}
      else if(key==='tone') {if(typeof value!=='string'||!Object.hasOwn(require('./ai-adapter').TONES,value))throw new Error('Invalid tone');}
      else if(key==='custom_instructions') {if(typeof value!=='string'||value.length>400)throw new Error('Custom instructions must be at most 400 characters');}
      else if(['custom_tone_prompt','promo_code','discount_amount'].includes(key)) {if(typeof value!=='string'||value.length>1000)throw new Error('Invalid setting');}
      else throw new Error('Unsupported setting');
      if(key==='widget_color'&&value!==null)settings.theme_preset='classic';
      settings[key]=['custom_instructions','custom_tone_prompt'].includes(key)?require('./ai-adapter').sanitizeInstructions(value,key==='custom_tone_prompt'?1000:400):value;
    }
    if(body.settings.theme_preset!==undefined&&body.settings.widget_color===undefined)settings.widget_color=null;
    if(body.settings.tone!==undefined)settings.friendly_tone=body.settings.tone==='friendly';
    else if(body.settings.friendly_tone!==undefined)settings.tone=body.settings.friendly_tone?'friendly':'formal';
    patch.settings=settings;
  }
  if(body.cancel_at_period_end!==undefined) {
    if(typeof body.cancel_at_period_end!=='boolean')throw new Error('Invalid cancellation flag');
    if(store.billing_source==='paddle')throw new Error('Paddle cancellation requires the billing integration');
    patch.cancel_at_period_end=body.cancel_at_period_end;
  }
  if(admin) {
    if(body.plan!==undefined) {const plan=String(body.plan).toLowerCase();if(!['starter','pro','business'].includes(plan))throw new Error('Invalid plan');patch.plan=plan;if(plan!==store.plan&&body.query_limit===undefined)patch.quota_override=null;}
    if(body.query_limit!==undefined) {if(!Number.isInteger(body.query_limit)||body.query_limit<0)throw new Error('Invalid limit');patch.quota_override=body.query_limit;}
    if(body.pause!==undefined) {if(typeof body.pause!=='boolean')throw new Error('Invalid pause');
      if(store.billing_source==='paddle'){patch.billing_hold=body.pause;patch.status=body.pause?'paused':['active','trialing'].includes(store.paddle_status)?store.paddle_status:'inactive';}
      else patch.status=body.pause?'paused':'active';
    }
    if(body.days_to_add!==undefined) {
      if(!Number.isInteger(body.days_to_add)||Math.abs(body.days_to_add)>3650)throw new Error('Invalid days');
      const until=new Date(Math.max(Date.now(),new Date(store.access_until).getTime())+body.days_to_add*86400000);
      if(body.days_to_add>0 && store.billing_source!=='paddle' && store.status==='inactive' && body.pause===undefined)patch.status='active';
      patch.access_until=new Date(Math.max(new Date(store.access_start).getTime(),until.getTime())).toISOString();
    }
  }
  return patch;
}
async function updateOwnedStore(db,ownerId,body,admin=false,storeId) {
  const store=await storeForOwner(db,ownerId,storeId);
  if(!store)throw new Error('Store is not provisioned');
  const patch=validatedPatch(body,store,admin);
  // A server-owned revision keeps compare-and-update URLs small even for long Unicode profiles.
  const previousRevision=store.settings?._cc_settings_revision;
  if(patch.settings)patch.settings._cc_settings_revision=require('node:crypto').randomUUID();
  let query=db.from('cc_stores').update(patch).eq('id',store.id).eq('owner_id',ownerId);
  if(patch.settings)query=previousRevision===undefined
    ?query.is('settings->>_cc_settings_revision',null)
    :query.eq('settings->>_cc_settings_revision',previousRevision);
  const {data,error}=await query.select().single();
  if(patch.settings&&(!data&&(!error||error.code==='PGRST116')))throw Object.assign(new Error('Settings changed concurrently. Reload before saving again.'),{code:'SETTINGS_CONFLICT'});
  if(error)throw error;
  return data;
}
function createAccountHandler(options={}) {
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(!['GET','PATCH','POST'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
    try {
      const db=options.db||serverDb();
      const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
      if(!token)return res.status(401).json({error:'AUTH_REQUIRED'});
      const {data,error}=await db.auth.getUser(token);
      if(error||!data?.user)return res.status(401).json({error:'INVALID_SESSION'});
      if(req.method==='GET'&&req.query?.list==='1') {
        const {data:stores,error:listError}=await db.from('cc_stores').select('id,domain,status').eq('owner_id',data.user.id).order('created_at').limit(100);
        if(listError)throw listError;
        return res.json({stores});
      }
      if(req.method==='POST') {
        if(!data.user.email_confirmed_at&&!data.user.confirmed_at)return res.status(403).json({error:'EMAIL_CONFIRMATION_REQUIRED'});
        const body=req.body;
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.store_domain!=='string')return res.status(400).json({error:'INVALID_STORE_INPUT'});
        const domain=body.store_domain.trim().toLowerCase();
        if(domain.length>253||!domain.includes('.')||domain.split('.').some(label=>!label||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))||!/[a-z]{2,}$/.test(domain)||domain==='mystore.com'||domain.endsWith('.localhost'))return res.status(400).json({error:'INVALID_STORE_DOMAIN'});
        // Persisted, per-identity throttling; metadata never controls the owner or access.
        const {createHash}=require('node:crypto');
        const {data:rate,error:rateError}=await db.rpc('consume_cc_rate_limit',{p_bucket:createHash('sha256').update('onboarding:'+data.user.id).digest('hex'),p_limit:10,p_window_seconds:60}).abortSignal(AbortSignal.timeout(5000));
        if(rateError)throw rateError;
        if(!rate?.allowed)return res.status(429).json({error:'RATE_LIMITED'});
        const {data:created,error:insertError}=await db.from('cc_stores').insert({owner_id:data.user.id,domain,plan:'starter',status:'inactive'}).select('id,domain,status').single();
        if(insertError) {
          if(insertError.code!=='23505')throw insertError;
          const {data:existing,error:lookupError}=await db.from('cc_stores').select('id,domain,status').eq('owner_id',data.user.id).eq('domain',domain).maybeSingle();
          if(lookupError)throw lookupError;
          if(!existing)return res.status(409).json({error:'DOMAIN_UNAVAILABLE'});
          return res.json({store:{id:existing.id,domain:existing.domain,status:existing.status},created:false});
        }
        return res.status(201).json({store:{id:created.id,domain:created.domain,status:created.status},created:true});
      }
      const storeId=req.query?.store_id;
      if(storeId!==undefined&&(typeof storeId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId)))return res.status(400).json({error:'INVALID_STORE_ID'});
      const store=await storeForOwner(db,data.user.id,storeId);
      if(!store)return res.status(404).json({error:'STORE_NOT_PROVISIONED'});
      if(req.method==='PATCH') {
        try { await updateOwnedStore(db,data.user.id,req.body||{},false,store.id); }
        catch(error){return res.status(error.code==='SETTINGS_CONFLICT'?409:400).json({error:error.code==='SETTINGS_CONFLICT'?'SETTINGS_CONFLICT':'INVALID_ACCOUNT_UPDATE',message:error.message});}
      }
      return res.status(200).json(await snapshot(db,store.id));
    } catch(error) {
      console.warn('[Account] Protected store data unavailable:',error.code||error.name);
      return res.status(503).json({error:'ACCOUNT_UNAVAILABLE'});
    }
  };
}
module.exports={serverDb,storeForOwner,snapshot,validatedPatch,updateOwnedStore,createAccountHandler};
