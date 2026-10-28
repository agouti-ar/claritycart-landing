const {test}=require('node:test');const assert=require('node:assert/strict');
const {providerDiagnostic}=require('../lib/gemini-diagnostics');const {generateResponse}=require('../api/chat');
test('provider diagnostics preserve status/reason while removing credentials and buyer text',()=>{
 const key='AIza'+'x'.repeat(35);const d=providerDiagnostic({code:403,status:'PERMISSION_DENIED',message:`Key ${key} https://example.test?key=SECRET&token=OTHER\nBuyer SECRET_QUESTION`,details:[{reason:'API_KEY_SERVICE_BLOCKED'}]},{apiKey:key,redact:['SECRET_QUESTION'],model:'gemini-test',httpStatus:403});
 assert.equal(d.code,403);assert.equal(d.status,'PERMISSION_DENIED');assert.deepEqual(d.reasons,['API_KEY_SERVICE_BLOCKED']);
 const s=JSON.stringify(d);for(const secret of [key,'SECRET_QUESTION','key=SECRET','token=OTHER'])assert.ok(!s.includes(secret));
});
test('slow first model times out per attempt and fallback succeeds within the parent deadline',async t=>{
 const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='synthetic-key';const logs=[],calls=[];
 const originalTimer=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>originalTimer(fn,ms===8000?10:ms,...args));
 t.mock.method(console,'warn',(...args)=>logs.push(args.join(' ')));
 t.mock.method(globalThis,'fetch',async(url,{signal})=>{calls.push(url);if(calls.length===1)return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:'Synthetic known fact'}]}}]})};});
 let body,status;const res={setHeader(){},status(n){status=n;return this;},json(b){body=b;return this;}};
 try{await generateResponse({method:'POST',body:{question:'Known fact?'},signal:new AbortController().signal,entitlement:{plan:'starter',settings:{}}},res);
 assert.equal(status,200);assert.equal(body.usedModel,'gemini-3.8-flash');assert.equal(calls.length,2);assert.ok(calls[0].includes('gemini-3.5-flash-lite'));assert.ok(logs.some(s=>s.includes('model_timeout')));assert.ok(calls.every(s=>!s.includes('1.5')&&!s.includes('2.0')));
 }finally{if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;}
});
test('real adapter logs provider failures without exposing them to the shopper',async t=>{
 const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='synthetic-key';const logs=[];
 t.mock.method(console,'warn',(...args)=>logs.push(args.join(' ')));
 t.mock.method(globalThis,'fetch',async()=>({ok:false,status:403,json:async()=>({error:{code:403,status:'PERMISSION_DENIED',message:'synthetic-key BUYER_TEXT denied',details:[{reason:'API_KEY_SERVICE_BLOCKED'}]}})}));
 let body,status;const res={setHeader(){},status(n){status=n;return this;},json(b){body=b;return this;}};
 try{await generateResponse({method:'POST',body:{question:'BUYER_TEXT'},entitlement:{plan:'starter',settings:{}}},res);
 assert.equal(status,502);assert.equal(body.error,'AI_UNAVAILABLE');assert.ok(logs.length>0);assert.ok(logs.every(s=>s.includes('PERMISSION_DENIED')&&!s.includes('synthetic-key')&&!s.includes('BUYER_TEXT')));assert.ok(!JSON.stringify(body).includes('PERMISSION_DENIED'));
 }finally{if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;}
});
