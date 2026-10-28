// Direct synthetic request; no store/user data or DB writes. Key is never printed.
require('dotenv').config({quiet:true});
const {providerDiagnostic}=require('../lib/gemini-diagnostics');
async function main(){
 const key=(process.env.GEMINI_API_KEY||'').trim().replace(/^["']|["']$/g,'');
 if(!key)throw new Error('GEMINI_API_KEY missing locally; configure it without posting it in chat');
 const model=process.argv[2]||'gemini-1.5-flash';if(model!=='--list'&&!/^gemini-[a-z0-9.-]+$/.test(model))throw new Error('Invalid model ID');
 const started=Date.now();
 try{
  if(model==='--list'){
   const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',{headers:{'x-goog-api-key':key},signal:AbortSignal.timeout(10000)});const data=await r.json();
   if(!r.ok){console.log(JSON.stringify(providerDiagnostic(data.error,{apiKey:key,httpStatus:r.status,category:'list_models'}),null,2));process.exitCode=1;return;}
   console.log(JSON.stringify({httpStatus:r.status,models:data.models?.filter(m=>m.supportedGenerationMethods?.includes('generateContent')).map(m=>m.name),hasNextPage:!!data.nextPageToken},null,2));return;
  }
  const generationConfig=/^gemini-3\./.test(model)||model==='gemini-flash-latest'?{maxOutputTokens:256,thinkingConfig:{thinkingLevel:'low'}}:{maxOutputTokens:32,temperature:0};
  const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{
   method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},signal:AbortSignal.timeout(20000),
   body:JSON.stringify({contents:[{parts:[{text:'Reply with exactly OK.'}]}],generationConfig})
  });
  const data=await r.json();
  if(!r.ok){console.log(JSON.stringify(providerDiagnostic(data.error,{apiKey:key,model,httpStatus:r.status,elapsedMs:Date.now()-started,category:'direct_probe'}),null,2));process.exitCode=1;return;}
  console.log(JSON.stringify({model,httpStatus:r.status,elapsedMs:Date.now()-started,hasAnswer:!!data.candidates?.some(c=>c.content?.parts?.some(p=>typeof p.text==='string'&&p.text.trim())),finishReasons:data.candidates?.map(c=>c.finishReason)},null,2));
 }catch(error){console.log(JSON.stringify(providerDiagnostic(error,{apiKey:key,model,elapsedMs:Date.now()-started,category:'direct_probe_transport'}),null,2));process.exitCode=1;}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
