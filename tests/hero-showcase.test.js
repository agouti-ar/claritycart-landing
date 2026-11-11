const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {parseHTML}=require('linkedom');const {frameAt,headingAt,mount,PRODUCTS}=require('../hero-showcase');const themes=require('../widget-themes');
function fixture(reduced=false){const html=fs.readFileSync('index.html','utf8'),{document,window}=parseHTML(html),host=document.getElementById('clarity-open-showcase');let now=0,next=0,queue=new Map(),intersection;
 window.matchMedia=()=>({matches:reduced,addEventListener(){},removeEventListener(){}});window.requestAnimationFrame=fn=>{queue.set(++next,fn);return next;};window.cancelAnimationFrame=id=>queue.delete(id);window.ClarityCartThemes=themes;window.IntersectionObserver=class{constructor(fn){intersection=fn;}observe(){}disconnect(){}};
 const controller=mount(host);function advance(ms){for(let i=0;i<ms/100;i++){now+=100;const tasks=[...queue.values()];queue.clear();tasks.forEach(fn=>fn(now));}}return {document,window,host,controller,advance,queue,intersection};}
test('single clock advances all phases and cycles three categories without cancelling later actions',()=>{
 for(const [t,phase]of [[0,'enter'],[2,'question'],[3.5,'checking'],[5,'answer'],[9,'action'],[11,'exit']])assert.equal(frameAt(t).phase,phase);
 assert.equal(frameAt(12).index,1);assert.equal(frameAt(24).index,2);assert.equal(frameAt(36).index,0);assert.equal(frameAt(-1).index,0);
});
test('no WebGL fallback still autoplays grounded category conversations and keeps pause usable',()=>{
 const h=fixture();assert.equal(h.host.dataset.renderer,'fallback');h.advance(5600);assert.equal(h.host.dataset.phase,'answer');assert.equal(h.host.querySelector('[data-product-answer]').textContent,PRODUCTS[0].answer);
 h.advance(3500);assert.equal(h.host.dataset.phase,'action');h.advance(3500);assert.equal(h.controller.getState().index,1);assert.equal(h.host.querySelector('[data-product-source]').textContent,PRODUCTS[1].source);
 const button=h.host.querySelector('.showcase-pause');button.dispatchEvent(new h.window.Event('click'));const time=h.controller.getState().t;h.advance(2500);assert.equal(h.controller.getState().t,time);button.dispatchEvent(new h.window.Event('click'));h.advance(1000);assert.ok(h.controller.getState().t>time);h.controller.destroy();assert.equal(h.queue.size,0);
});
test('reduced motion is a readable static answer; category and shared theme controls work',()=>{
 const h=fixture(true);h.advance(2000);assert.equal(h.host.dataset.phase,'answer');assert.equal(h.queue.size,0);
 const choices=h.host.querySelectorAll('[data-category]');choices[2].dispatchEvent(new h.window.Event('click'));assert.equal(h.controller.getState().index,2);assert.equal(h.host.querySelector('[data-product-answer]').textContent,PRODUCTS[2].answer);
 for(const theme of Object.keys(themes.PRESETS)){h.host.querySelector('[data-showcase-theme="'+theme+'"]').dispatchEvent(new h.window.Event('click'));assert.equal(h.host.querySelector('.showcase-chat').getAttribute('data-cc-theme'),theme);}
 h.controller.destroy();
});
test('offscreen pause preserves time and resumes without skipping the story',()=>{
 const h=fixture();h.advance(3000);h.intersection([{isIntersecting:false}]);const t=h.controller.getState().t;h.advance(10000);assert.equal(h.controller.getState().t,t);assert.equal(h.queue.size,0);h.intersection([{isIntersecting:true}]);h.advance(1000);assert.ok(h.controller.getState().t>t);assert.ok(h.controller.getState().t<t+1.1);h.controller.destroy();
});
test('paused category selection shows a complete frame; reduced-motion Play starts on first click',()=>{
 const h=fixture();h.host.querySelector('.showcase-pause').dispatchEvent(new h.window.Event('click'));h.host.querySelector('[data-category="chair"]').dispatchEvent(new h.window.Event('click'));assert.equal(h.host.dataset.phase,'answer');assert.equal(h.controller.getState().index,1);h.advance(2000);assert.equal(h.controller.getState().t,5.5);h.controller.destroy();
 const r=fixture(true);r.host.querySelector('.showcase-pause').dispatchEvent(new r.window.Event('click'));r.advance(1000);assert.ok(r.controller.getState().t>5.5);r.controller.destroy();
});
test('heading fades on the master clock, stays readable on pause and reduced motion',()=>{
 assert.equal(headingAt(0),0);assert.equal(headingAt(.35),1);assert.ok(headingAt(.15)>0&&headingAt(.15)<1);assert.equal(headingAt(10.7),0);assert.equal(headingAt(0,true),1);
 const h=fixture();h.controller.seek(10.7);assert.equal(h.host.querySelector('.showcase-heading').style.opacity,'0');h.controller.seek(12.1);assert.equal(h.host.querySelector('[data-product-title]').textContent,PRODUCTS[1].name);assert.ok(Number(h.host.querySelector('.showcase-heading').style.opacity)<1);h.controller.destroy();
});
test('cart counts only after visual arrival, resets for a new category and does not imply a paid order',()=>{
 const h=fixture();h.controller.seek(8.5);assert.equal(h.host.querySelector('[data-cart-count]').textContent,'0');h.controller.seek(9.4);assert.equal(h.host.querySelector('[data-cart-count]').textContent,'1');assert.equal(h.host.querySelector('[data-action-detail]').textContent,'Added to cart');h.controller.seek(10.8);assert.equal(h.host.querySelector('[data-cart-count]').textContent,'1');h.controller.seek(12);assert.equal(h.host.querySelector('[data-cart-count]').textContent,'0');h.controller.destroy();
});
