const {serverDb,snapshot}=require('../lib/store-access');
function publicSettings(store) {
 const pro=['pro','business'].includes(store.plan)&&store.access_active;
 const business=store.plan==='business'&&store.access_active;
 const s=store.settings||{};
 return {widget_color:s.widget_color||'#3B82F6',theme_preset:pro?s.theme_preset||'classic':'classic',
 friendly_tone:pro?s.friendly_tone!==false:true,use_emojis:s.use_emojis!==false,
 white_label:business&&s.white_label===true,exit_intent:pro&&s.exit_intent===true,
 plan:store.plan,access_active:store.access_active};
}
function createConfigHandler(options={}) {return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Access-Control-Allow-Origin','*');
 res.setHeader('Access-Control-Allow-Methods','OPTIONS,GET');res.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(req.method==='OPTIONS')return res.status(200).end();
 if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
 const domain=String(req.query?.domain||req.query?.store_domain||'').trim().toLowerCase();
 if(!domain)return res.status(400).json({error:'STORE_REQUIRED'});
 try {const db=options.db||serverDb();const {data,error}=await db.from('cc_stores').select('id').eq('domain',domain).maybeSingle();
  if(error)throw error;if(!data)return res.status(404).json({error:'UNKNOWN_STORE'});
  return res.status(200).json(publicSettings(await snapshot(db,data.id)));
 }catch(error){return res.status(503).json({error:'CONFIG_UNAVAILABLE'});}
};}
module.exports=createConfigHandler();module.exports.createConfigHandler=createConfigHandler;module.exports.publicSettings=publicSettings;
