const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const {webcrypto}=require('node:crypto');const {parseHTML}=require('linkedom');
const source=fs.readFileSync('clarity.js','utf8');const code=source.slice(source.indexOf('    class ClarityAnalytics'),source.indexOf('    class ClarityCartWidget'))+';globalThis.Tracker=ClarityAnalytics;';
const tick=()=>new Promise(r=>setImmediate(r));
function harness(options={}){
 const local=options.local||new Map(),session=options.session||new Map(),calls=[];const storage=m=>({getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)});
 const {document}=parseHTML('<html><body></body></html>');Object.defineProperty(document,'baseURI',{value:'https://shop.example/products/lamp'});
 let time=Date.now();const window={ClarityCartConfig:options.config||{},location:{pathname:'/products/lamp',origin:'https://shop.example'},addEventListener(){},...options.window};
 const ctx={window,document,navigator:options.navigator||{},isLocalDev:options.isLocalDev||false,resolveStoreDomain:()=> 'shop.example',localStorage:storage(local),sessionStorage:storage(session),crypto:webcrypto,
 Date:class extends Date{static now(){return time;}},setInterval(){return 1;},API_URL:'https://api.example/api/chat',URL,AbortSignal,
 fetch:async(url,init)=>{if(!init.body)return {ok:options.cartOk!==false,status:options.cartOk===false?422:200,clone:()=>({json:async()=>options.cartData||{id:42,quantity:1}})};calls.push({url,init,body:JSON.parse(init.body)});if(options.fail)throw Error('Lost response');return {ok:true,status:200};}};
 window.fetch=ctx.fetch;vm.createContext(ctx);vm.runInContext(code,ctx);
 const tracker=new ctx.Tracker({isAnalyticsProductPage:()=>true,getRequestSession:async()=>({widget_session:'signed-session'})});
 return {tracker,ctx,document,calls,local,session,advance:n=>{time+=n;}};
}
test('widget records product view + session, reuses browser identity, rolls after 30 minute inactivity',async()=>{
 const h=harness();await tick();assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].body.events.map(e=>e.type),['session_start','product_view']);
 const identity=h.tracker.identity();h.advance(1800001);h.tracker.record('cart_add','merchant_confirmed');await tick();
 const next=h.calls.at(-1).body;assert.equal(next.visitor_id,identity.visitor_id);assert.notEqual(next.session_id,identity.session_id);assert.equal(next.events.at(-1).source,'merchant_confirmed');
 assert.equal(JSON.stringify(h.calls).includes('?'),false);
});
test('lost analytics ACK/reload retries original event IDs; no browser usage/answer events',async()=>{
 const h=harness({fail:true});await tick();const ids=h.calls[0].body.events.map(e=>e.event_id);assert.equal(h.tracker.queue.length,2);
 const reloaded=harness({local:h.local,session:h.session});await tick();assert.deepEqual(reloaded.calls[0].body.events.slice(0,2).map(e=>e.event_id),ids);
 assert.equal(reloaded.tracker.queue.length,0);assert.equal(reloaded.calls[0].url,'https://api.example/api/events');
});
test('privacy opt-out, preview/mock and local developer sessions produce no events or identity',async()=>{
 for(const options of [{config:{analyticsConsent:false}},{config:{previewAccessToken:'owner'}},{config:{mockMode:true}},{navigator:{globalPrivacyControl:true}},{navigator:{doNotTrack:'1'}},{isLocalDev:true}]){
  const h=harness(options);await tick();assert.equal(h.calls.length,0);assert.equal(h.local.size,0);assert.equal(h.tracker.identity(),null);
 }
});
test('generic cart bridge requires confirmed success; click alone does not count',async()=>{
 const h=harness();await tick();const event=new h.document.defaultView.Event('claritycart:cart-added');event.detail={confirmed:false};h.document.dispatchEvent(event);await tick();assert.equal(h.calls.length,1);
 const success=new h.document.defaultView.Event('claritycart:cart-added');success.detail={confirmed:true};h.document.dispatchEvent(success);await tick();assert.equal(h.calls.at(-1).body.events[0].type,'cart_add');
});
test('metrics renderer uses actual aggregates, shows failure and never invents revenue',()=>{
 const {render}=require('../analytics-ui');const {document}=parseHTML('<div id="total-questions"></div><div id="analytics-sessions"></div><div id="time-saved"></div><div id="metric-revenue"></div><div id="analytics-status"></div>');
 render(document,{questions_answered:7,sessions:4,estimated_time_saved_seconds:1050});assert.equal(document.getElementById('total-questions').textContent,'7');assert.equal(document.getElementById('analytics-sessions').textContent,'4');assert.equal(document.getElementById('time-saved').textContent,'17.5 mins');assert.equal(document.getElementById('metric-revenue').textContent,'Not connected');
 render(document,null);assert.equal(document.getElementById('total-questions').textContent,'0');assert.match(document.getElementById('analytics-status').textContent,/unavailable/);
});
test('Shopify adapter preserves fetch response and records only successful cart POST',async()=>{
 const h=harness({window:{Shopify:{}}});await tick();
 const response=await h.ctx.window.fetch('https://shop.example/cart/add.js',{method:'POST'});await tick();assert.equal(response.ok,true);assert.equal(h.calls.at(-1).body.events.at(-1).source,'shopify_ajax');
 const falseSuccess=harness({window:{Shopify:{}},cartData:{error:'not added'}});await tick();await falseSuccess.ctx.window.fetch('https://shop.example/cart/add.js',{method:'POST'});await tick();assert.equal(falseSuccess.calls.length,1);
 const failed=harness({window:{Shopify:{}},cartOk:false});await tick();await failed.ctx.window.fetch('https://shop.example/cart/add.js',{method:'POST'});await tick();assert.equal(failed.calls.length,1);
});
