const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const {mountBillingUI}=require('../billing-ui');
function setup(extra={}) {
 const {document}=parseHTML('<html><body></body></html>');
 const values=new Map(),calls=[],visits=[];
 document.defaultView.HTMLDialogElement;
 const original=document.createElement.bind(document);
 document.createElement=name=>{const el=original(name);if(name==='dialog')el.showModal=()=>{el.open=true;};return el;};
 const txn='txn_'+'a'.repeat(26);
 const ui=mountBillingUI({document,getStoreId:()=> 'store-1',getSession:async()=>({access_token:'test-jwt'}),
 storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},randomUUID:()=> 'stable-request',navigate:url=>visits.push(url),
 fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.includes('/status')?{trial_available:true}: {status:'ready',transaction_id:txn,checkout_url:'https://checkout.example/billing?_ptxn='+txn}};},...extra});
 return {ui,calls,visits,document};
}
test('owner checkout preserves request ID on retry and opens validated URL',async()=>{
 const {ui,calls,visits}=setup();await ui.open();await ui.select('pro');await ui.select('pro');
 assert.equal(calls.length,3);const bodies=calls.slice(1).map(c=>JSON.parse(c.options.body));
 assert.equal(bodies[0].request_id,bodies[1].request_id);assert.equal(bodies[0].plan,'pro');assert.equal(bodies[0].store_id,'store-1');assert.equal(visits.length,2);
 assert.equal(calls[1].options.headers.Authorization,'Bearer test-jwt');
});
test('double submit while checkout is pending sends one request',async()=>{
 let release;let count=0;
 const {ui}=setup({fetch:async(url)=>({ok:true,json:async()=>url.includes('/status')?{}:await new Promise(resolve=>{count++;release=()=>resolve({status:'completed'});})})});
 await ui.open();const first=ui.select('starter');await new Promise(resolve=>setImmediate(resolve));await ui.select('starter');assert.equal(count,1);release();await first;
});
test('mock is explicit and makes no network calls or entitlement changes',async()=>{
 const {ui,calls,visits}=setup({mock:true});await ui.open();await ui.select('business');assert.equal(calls.length,0);assert.equal(visits.length,0);assert.match(ui.dialog.textContent,/LOCAL MOCK/);
});
test('missing auth and unconfigured billing fail closed with no navigation',async()=>{
 const {ui,calls,visits}=setup({getSession:async()=>null});await ui.open();await ui.select('business');assert.equal(calls.length,0);assert.equal(visits.length,0);assert.match(ui.dialog.textContent,/sign in/);
 const failed=setup({fetch:async()=>({ok:false,status:503,json:async()=>({error:'BILLING_DATABASE_UNAVAILABLE'})})});await failed.ui.open();assert.match(failed.ui.dialog.textContent,/not configured/);assert.equal(failed.visits.length,0);
});
test('malicious redirect and external error text cannot execute markup',async()=>{
 const {ui,visits}=setup({fetch:async(url)=>({ok:true,json:async()=>url.includes('/status')?{}:{status:'ready',transaction_id:'txn_'+'a'.repeat(26),checkout_url:'javascript:alert(1)'}})});await ui.open();await ui.select('pro');assert.equal(visits.length,0);assert.match(ui.dialog.textContent,/Invalid checkout/);
});
test('existing subscription prevents new checkout',async()=>{
 let count=0;const {ui}=setup({fetch:async()=>{count++;return {ok:true,json:async()=>({subscription:{status:'active'}})};}});await ui.open();await ui.select('pro');assert.equal(count,1);assert.match(ui.dialog.textContent,/already have a subscription/);
});

test('only a definite failed checkout clears the retry ID; ambiguous responses retain it',async()=>{
 const values=new Map();let generation=0, code='CHECKOUT_PENDING_RECONCILIATION';
 const {ui}=setup({storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},randomUUID:()=> 'id-'+(++generation),
 fetch:async(url)=>url.includes('/status')?{ok:true,json:async()=>({})}:{ok:false,status:409,json:async()=>({error:code})}});
 await ui.open();await ui.select('starter');await ui.select('starter');assert.equal(generation,1);assert.equal(values.size,1);
 code='CHECKOUT_FAILED_USE_NEW_REQUEST';await ui.select('starter');assert.equal(values.size,0);await ui.select('starter');assert.equal(generation,2);
});
