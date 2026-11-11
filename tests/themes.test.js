const {test}=require('node:test');const assert=require('node:assert/strict');const {parseHTML}=require('linkedom');
const themes=require('../widget-themes');const preview=require('../theme-preview');const {publicSettings}=require('../api/config');const {validatedPatch}=require('../lib/store-access');
test('four complete token systems, legacy alias, custom accent and readable foreground',()=>{
 assert.equal(Object.keys(themes.PRESETS).length,4);const signatures=new Set();
 for(const name of Object.keys(themes.PRESETS)){
  const base=themes.tokens(name);signatures.add(JSON.stringify(base.values));assert.equal(Object.keys(base.values).length,15);
  for(const color of ['#ffffff','#000000','#00ff00','#123456','#ffff00']){const t=themes.tokens(name,color);assert.equal(t.values.accent,color.toUpperCase());assert.ok(themes.contrast(t.values.accent,t.values['on-accent'])>=4.5);}
  assert.deepEqual(themes.tokens(name,'red; background:url(x)'),base);
 }
 assert.equal(signatures.size,4);assert.deepEqual(themes.tokens('neon_pop'),themes.tokens('solar_graphite'));assert.equal(themes.normalize('__proto__'),'classic');
});
test('shared shadow preview switches all tokens and resets custom accent',()=>{
 const {document}=parseHTML('<div id="preview"></div>');const host=document.getElementById('preview');const view=preview.mount(host);
 for(const name of Object.keys(themes.PRESETS)){
  view.update(name,'#abcdef');const el=host.shadowRoot.querySelector('.widget-container');assert.equal(el.getAttribute('data-cc-theme'),name);assert.equal(el.style.getPropertyValue('--cc-accent'),'#ABCDEF');
  view.update(name,null);for(const[k,v]of Object.entries(themes.tokens(name).values))assert.equal(el.style.getPropertyValue('--cc-'+k),v);
 }
 assert.match(preview.detectionMessage({detected:false,color:'#3B82F6'}),/No brand color found/);assert.match(preview.detectionMessage({detected:true,source:'css_variable',color:'#112233'}),/Site color found/);
});
test('settings accept all presets and legacy alias, preserve other tools, reject CSS injection',()=>{
 const store={plan:'pro',settings:{promo_code:'KEEP',white_label:true,mock_mode:true}};
 for(const theme_preset of [...Object.keys(themes.PRESETS),'neon_pop']){
  const result=validatedPatch({settings:{theme_preset,widget_color:null}},store);assert.equal(result.settings.theme_preset,theme_preset);assert.equal(result.settings.promo_code,'KEEP');assert.equal(result.settings.white_label,true);
  assert.equal(publicSettings({plan:'pro',access_active:true,settings:result.settings}).theme_preset,theme_preset);
  assert.equal(publicSettings({plan:'starter',access_active:true,settings:result.settings}).theme_preset,'classic');
 }
 for(const settings of [{theme_preset:'evil'},{widget_color:'url(x)'},{widget_color:[]},{theme_preset:{}}])assert.throws(()=>validatedPatch({settings},store));
 assert.equal(publicSettings({plan:'pro',access_active:true,settings:{}}).widget_color,null);
});
test('actual widget methods reuse one theme stylesheet; live null reset restores native accent',()=>{
 const vm=require('node:vm'),fs=require('node:fs');const source=fs.readFileSync('clarity.js','utf8');
 const code=source.slice(source.indexOf('    class ClarityCartWidget'),source.lastIndexOf('    new ClarityCartWidget();'))+';globalThis.Widget=ClarityCartWidget;';
 const {document}=parseHTML('<html><head></head><body><button id="add-to-cart">Add to cart</button><div id="host"></div></body></html>');const cfg={themePreset:'classic',widgetColor:null};
 const ctx=vm.createContext({window:{ClarityCartConfig:cfg,ClarityCartThemes:themes},document,console,setTimeout:()=>1,clearTimeout(){}});vm.runInContext(code,ctx);
 const widget=Object.create(ctx.Widget.prototype);widget.shadow=document.getElementById('host').attachShadow({mode:'open'});widget.shadow.innerHTML='<section class="widget-container"></section>';widget.targetSelector='#add-to-cart';
 ctx.widget=widget;vm.runInContext('(function(){'+source.slice(source.indexOf('            this.applyLiveSetting ='),source.indexOf('            // 1. Storage Event Listener'))+'}).call(widget);',ctx);
 for(const theme_preset of ['solar_graphite','mint_lavender','berry_coral','neon_pop','classic']){
  widget.applyLiveSetting('theme_preset',theme_preset);widget.applyLiveSetting('widget_color','#123456');assert.equal(widget.shadow.querySelector('.widget-container').style.getPropertyValue('--cc-accent'),'#123456');
  widget.applyLiveSetting('widget_color',null);assert.equal(widget.shadow.querySelector('.widget-container').style.getPropertyValue('--cc-accent'),themes.tokens(theme_preset).values.accent);
  assert.equal(widget.shadow.querySelectorAll('#clarity-preset-theme').length,1);
 }
 assert.equal(document.getElementById('add-to-cart').getAttribute('style'),null);assert.equal(document.getElementById('clarity-global-neon-style'),null);
});

test('Starter rejects paid settings; Pro rejects white-label; accent selects Classic atomically',()=>{
 assert.throws(()=>validatedPatch({settings:{widget_color:'#123456'}},{plan:'starter',settings:{}}),/requires Pro/);
 assert.throws(()=>validatedPatch({settings:{white_label:true}},{plan:'pro',settings:{}}),/Business/);
 const store={plan:'pro',settings:{theme_preset:'mint_lavender',widget_color:'#123456'}};
 assert.equal(validatedPatch({settings:{widget_color:'#abcdef'}},store).settings.theme_preset,'classic');
 assert.equal(validatedPatch({settings:{theme_preset:'berry_coral'}},store).settings.widget_color,null);
 assert.equal(validatedPatch({plan:'pro'},{plan:'starter',settings:{}},true).quota_override,null);
});
