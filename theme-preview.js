(function(root){
 'use strict';
 const themes=typeof module!=='undefined'&&module.exports?require('./widget-themes'):root.ClarityCartThemes;
 function detectionMessage(result){return result.detected===true?`Site color found (${result.source}): ${result.color}`:'No brand color found. Default blue (#3B82F6) applied.';}
 function mount(host){
  const shadow=host.shadowRoot||host.attachShadow({mode:'open'});
  // Static sample only. No merchant or customer data is interpolated into HTML.
  shadow.innerHTML=`<style>${themes.CSS}
  *{box-sizing:border-box} .header,.input-container{display:flex;gap:10px;align-items:center}.header{justify-content:space-between;margin-bottom:14px}.title{font-size:14px;font-weight:600}.ai-badge,.footer{font-size:10px}.ai-badge{padding:5px;border-radius:9px}.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{padding:9px;cursor:pointer}.chat-container{border-top:1px solid;margin-top:14px;padding-top:14px}.message{padding:11px;font-size:13px;margin-bottom:10px;line-height:1.5;max-width:90%}.message.user{margin-left:auto}.input-field{padding:10px;flex:1;width:100%;font:inherit}.send-btn{width:36px;height:36px;flex-shrink:0}.footer{text-align:center;margin-top:12px}
  </style><section class="widget-container" aria-label="Widget theme preview"><div class="header"><span class="title">Questions before buying?</span><span class="ai-badge">AI · Instant answers</span></div><div class="chips"><button type="button" class="chip">Product details</button><button type="button" class="chip">Return policy</button></div><div class="chat-container"><div class="message user">What should I know?</div><div class="message ai">Ask about this product. I’ll use the information available from the store.</div><div class="input-container"><input class="input-field" placeholder="Ask about this product…" aria-label="Preview question"><button type="button" class="send-btn" aria-label="Preview send">➤</button></div></div><div class="footer">Powered by ClarityCart · Visual preview</div></section>`;
  const container=shadow.querySelector('.widget-container');return {update:(preset,color)=>themes.apply(container,preset,color)};
 }
 const api={mount,detectionMessage};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ClarityThemePreview=api;
})(typeof window==='undefined'?globalThis:window);
