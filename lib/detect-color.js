const {createSiteFetcher,target,SiteError}=require('./safe-site-fetch');
const {serverDb,storeForOwner,snapshot}=require('./store-access');const {rate,adminEmails}=require('./request-security');
const FALLBACK=Object.freeze({detected:false,source:'fallback',color:'#3B82F6'});
function color(value){
 if(typeof value!=='string')return null;const s=value.trim();
 if(/^#[0-9a-f]{3}$/i.test(s))return '#'+[...s.slice(1)].map(c=>c+c).join('').toUpperCase();
 if(/^#[0-9a-f]{6}$/i.test(s))return s.toUpperCase();
 const rgb=s.match(/^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/i);if(rgb&&rgb.slice(1).every(n=>Number(n)<=255))return '#'+rgb.slice(1).map(n=>Number(n).toString(16).padStart(2,'0')).join('').toUpperCase();
 return ({black:'#000000',white:'#FFFFFF',navy:'#000080',blue:'#0000FF',teal:'#008080',purple:'#800080',rebeccapurple:'#663399'})[s.toLowerCase()]||null;
}
function attrs(tag){const out=Object.create(null);for(const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))out[m[1].toLowerCase()]=(m[2]??m[3]??m[4]).replace(/&amp;/gi,'&');return out;}
function cssColor(css){
 const values=new Map();const clean=css.replace(/\/\*[\s\S]*?\*\//g,'');
 for(const block of clean.matchAll(/(?:^|[}\s])(?:\:root|html|body)\s*\{([^}]{0,64000})\}/gi))for(const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)(?:;|$)/g))if(values.size<100)values.set(m[1].toLowerCase(),m[2].trim().replace(/\s*!important\s*$/i,''));
 function resolve(v,seen=new Set()){const result=color(v);if(result)return result;const key=v?.match(/^var\((--[\w-]+)\)$/i)?.[1]?.toLowerCase();if(!key||seen.has(key)||seen.size>3)return null;seen.add(key);return resolve(values.get(key),seen);}
 for(const key of ['--brand-color','--color-brand','--primary-color','--color-primary','--accent-color','--color-accent','--brand','--primary','--accent','--theme-color']){const result=resolve(values.get(key));if(result)return result;}return null;
}
async function detectColor(input,options={}){
 const fetcher=createSiteFetcher(options);try{
  const page=await fetcher.get(input,['text/html','application/xhtml+xml'],180000);
  const html=page.text.replace(/<!--[\s\S]*?-->/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'');
  const withoutStyles=html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,'');
  for(const tag of withoutStyles.matchAll(/<meta\b[^>]*>/gi)){const a=attrs(tag[0]);if(['theme-color','msapplication-tilecolor'].includes(a.name?.toLowerCase())){const c=color(a.content);if(c)return {detected:true,source:'meta_theme_color',color:c};}}
  const styles=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(m=>m[1]).join('\n');const inline=cssColor(styles);if(inline)return {detected:true,source:'css_variable',color:inline};
  const links=[...withoutStyles.matchAll(/<link\b[^>]*>/gi)].map(m=>attrs(m[0])).slice(0,60);
  const manifest=links.find(a=>a.rel?.toLowerCase().split(/\s+/).includes('manifest')&&a.href);
  if(manifest)try{const result=await fetcher.get(new URL(manifest.href,page.url).href,['application/manifest+json','application/json'],16000);const data=JSON.parse(result.text);const c=color(data.theme_color);if(c)return {detected:true,source:'manifest_theme_color',color:c};}catch(error){if(['UNSAFE_TARGET','UNSAFE_DNS','PIN_MISMATCH'].includes(error.code))throw error;}
  for(const link of links.filter(a=>a.rel?.toLowerCase().split(/\s+/).includes('stylesheet')&&a.href).slice(0,2))try{
   const result=await fetcher.get(new URL(link.href,page.url).href,['text/css'],64000);const c=cssColor(result.text);if(c)return {detected:true,source:'css_variable',color:c};
  }catch(error){if(['UNSAFE_TARGET','UNSAFE_DNS','PIN_MISMATCH'].includes(error.code))throw error;}
  const icon=links.find(a=>a.rel?.toLowerCase().split(/\s+/).includes('icon')&&a.href&&(a.type==='image/svg+xml'||/\.svg(?:[?#]|$)/i.test(a.href)));
  if(icon)try{const result=await fetcher.get(new URL(icon.href,page.url).href,['image/svg+xml'],32000);
   if(!/<!doctype|<script\b/i.test(result.text)){const fills=new Set([...result.text.matchAll(/\bfill\s*=\s*["'](#[0-9a-f]{3,6})["']/gi)].map(m=>color(m[1])).filter(c=>c&&Math.max(...c.slice(1).match(/../g).map(n=>parseInt(n,16)))-Math.min(...c.slice(1).match(/../g).map(n=>parseInt(n,16)))>30));if(fills.size===1)return {detected:true,source:'svg_icon_fill',color:[...fills][0]};}
  }catch(error){if(['UNSAFE_TARGET','UNSAFE_DNS','PIN_MISMATCH'].includes(error.code))throw error;}
  return {...FALLBACK};
 }finally{fetcher.close();}
}
function createDetectColorHandler(options={}){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
 if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='GET')return res.status(405).json({...FALLBACK,error:'METHOD_NOT_ALLOWED'});
 try{
  const db=options.db||serverDb();const token=(req.headers?.authorization||'').match(/^Bearer (.+)$/)?.[1];if(!token)return res.status(401).json({...FALLBACK,error:'AUTH_REQUIRED'});
  const auth=await db.auth.getUser(token);if(auth.error||!auth.data?.user)return res.status(401).json({...FALLBACK,error:'INVALID_SESSION'});
  const url=target(req.query?.url||req.query?.domain);
  if(req.query?.store_id!==undefined&&(typeof req.query.store_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.query.store_id)))return res.status(400).json({...FALLBACK,error:'INVALID_STORE_ID'});
  const store=await storeForOwner(db,auth.data.user.id,req.query?.store_id);if(!store||store.domain!==url.hostname)return res.status(403).json({...FALLBACK,error:'STORE_OWNER_MISMATCH'});
  const state=await snapshot(db,store.id);const admin=adminEmails().includes(String(auth.data.user.email||'').toLowerCase());
  if(!admin&&(!state.access_active||!['pro','business'].includes(state.plan)))return res.status(403).json({...FALLBACK,error:'PLAN_REQUIRED'});
  await rate(db,'color:owner:'+auth.data.user.id,10,options.secret);
  try{return res.json(await detectColor(url.href,options));}
  catch(error){const unsafe=['UNSAFE_TARGET','UNSAFE_DNS','PIN_MISMATCH','UNSAFE_REDIRECT','REDIRECT_LIMIT'].includes(error.code);return res.status(unsafe?400:200).json({...FALLBACK,reason:unsafe?'unsafe_target':'site_unavailable'});}
 }catch(error){return res.status(error instanceof SiteError?400:error.status||503).json({...FALLBACK,error:error instanceof SiteError?error.code:error.code&&error.status?error.code:'COLOR_UNAVAILABLE'});}
};}
module.exports={color,cssColor,detectColor,createDetectColorHandler,FALLBACK};
