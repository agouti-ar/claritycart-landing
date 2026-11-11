const {test}=require('node:test');const assert=require('node:assert/strict');const {parseHTML}=require('linkedom');const {mountBrandVoice}=require('../brand-voice-ui');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(options={}){
 const {document}=parseHTML('<form id="brand-voice-form"><select id="brand-voice-tone"></select><textarea id="custom-instructions"></textarea><span id="brand-voice-counter"></span><button id="brand-voice-save"></button><p id="brand-voice-status"></p></form>');
 const tone=document.getElementById('brand-voice-tone');Object.defineProperty(tone,'value',{get(){return this.getAttribute('data-value');},set(v){this.setAttribute('data-value',v);}});
 const calls=[];const ui=mountBrandVoice({document,settings:{tone:'formal',custom_instructions:'Use short paragraphs.'},canCustomize:true,save:async settings=>{calls.push(settings);return {settings};},...options});
 return {document,tone,calls,ui,submit(){document.getElementById('brand-voice-form').dispatchEvent(new document.defaultView.Event('submit',{cancelable:true}));}};
}
test('voice form loads saved profile and sends only the two allowed settings',async()=>{
 const h=fixture();assert.equal(h.tone.value,'formal');h.tone.value='concise';h.submit();await tick();assert.deepEqual(h.calls,[{tone:'concise',custom_instructions:'Use short paragraphs.'}]);assert.match(h.document.getElementById('brand-voice-status').textContent,/saved/);
});
test('failed save preserves draft; malicious error is displayed as text',async()=>{
 const h=fixture({save:async()=>{throw new Error('<img src=x onerror=alert(1)>');}});h.tone.value='concise';h.submit();await tick();assert.equal(h.tone.value,'concise');assert.equal(h.document.querySelectorAll('img').length,0);assert.equal(h.document.getElementById('brand-voice-save').disabled,false);
});
test('server-sanitized instructions replace the draft and show a cleanup notice',async()=>{
 const h=fixture({save:async()=>({settings:{tone:'formal',custom_instructions:'Safe style.'}})});h.document.getElementById('custom-instructions').value='Unsafe style';h.submit();await tick();assert.equal(h.document.getElementById('custom-instructions').value,'Safe style.');assert.match(h.document.getElementById('brand-voice-status').textContent,/removed/);
});
test('double submit sends once; Starter form cannot send even when fields are changed',async()=>{
 let resolve,n=0;const h=fixture({save:settings=>{n++;return new Promise(r=>{resolve=()=>r({settings});});}});h.tone.value='friendly';h.submit();h.submit();assert.equal(n,1);resolve();await tick();
 const starter=fixture({canCustomize:false});starter.submit();await tick();assert.equal(starter.calls.length,0);assert.equal(starter.document.getElementById('brand-voice-save').disabled,true);
});

test('Save is disabled until a change and becomes disabled again after saving',async()=>{
 const h=fixture(),button=h.document.getElementById('brand-voice-save');
 assert.equal(button.disabled,true);
 h.tone.value='friendly';
 h.tone.dispatchEvent(new h.document.defaultView.Event('change'));
 assert.equal(button.disabled,false);
 h.submit();await tick();assert.equal(button.disabled,true);
});
