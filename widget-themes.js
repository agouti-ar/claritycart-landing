(function(root){
 'use strict';
 const PRESETS=Object.freeze({
  classic:{name:'Neutral Brand',bg:'#FFFFFF',surface:'#F4F6F8',text:'#1F2937',muted:'#667085',accent:'#3B82F6',border:'#DFE4EB',radius:'14px',control:'12px',chip:'#F4F6F8',chipText:'#344054',shadow:'0 6px 22px rgba(15,23,42,.07)',keyShadow:'none'},
  solar_graphite:{name:'Solar Graphite',bg:'#25262B',surface:'#303239',text:'#F6F4EA',muted:'#BABCC5',accent:'#F3CA4D',border:'#4D4F57',radius:'22px',control:'999px',chip:'#F3CA4D',chipText:'#24252B',shadow:'0 8px 24px rgba(15,17,24,.14)',keyShadow:'0 2px 0 rgba(0,0,0,.32)'},
  mint_lavender:{name:'Mint Lavender',bg:'#DDEEE4',surface:'#FFF9EB',text:'#293F39',muted:'#596B65',accent:'#7752A0',border:'#C9D4CA',radius:'26px',control:'14px',chip:'#E5DEF0',chipText:'#49385E',shadow:'0 7px 24px rgba(65,85,75,.09)',keyShadow:'0 2px 0 rgba(76,60,98,.12)'},
  berry_coral:{name:'Berry Coral',bg:'#F9D9DF',surface:'#FFF1E9',text:'#542B40',muted:'#80566A',accent:'#B63D58',border:'#E4B8C1',radius:'18px',control:'10px',chip:'#F8D3CD',chipText:'#622A42',shadow:'0 8px 24px rgba(110,48,68,.10)',keyShadow:'0 3px 0 rgba(110,48,68,.13)'}
 });
 const normalize=value=>value==='neon_pop'?'solar_graphite':typeof value==='string'&&Object.hasOwn(PRESETS,value)?value:'classic';
 const isPreset=value=>typeof value==='string'&&(value==='neon_pop'||Object.hasOwn(PRESETS,value));
 function luminance(hex){return hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);}
 function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
 function tokens(preset,color){
  const key=normalize(preset),p=PRESETS[key],accent=typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color)?color.toUpperCase():p.accent;
  const ink=contrast(accent,'#000000')>contrast(accent,'#FFFFFF')?'#000000':'#FFFFFF';
  return {preset:key,values:{bg:p.bg,surface:p.surface,text:p.text,muted:p.muted,accent,'on-accent':ink,'accent-ink':contrast(accent,p.bg)>=4.5?accent:p.text,
   border:p.border,radius:p.radius,'control-radius':p.control,'chip-bg':p.chip,'chip-text':p.chipText,shadow:p.shadow,'key-shadow':p.keyShadow,'focus-ring':accent+'55'}};
 }
 const CSS=`
 .widget-container{font-family:Inter,system-ui,sans-serif;background:var(--cc-bg);color:var(--cc-text);border:1px solid var(--cc-border);border-radius:var(--cc-radius);box-shadow:var(--cc-shadow);padding:16px;overflow:hidden}
 .widget-container:hover{box-shadow:var(--cc-shadow)}
 .title,.title-icon{color:var(--cc-text)}
 .ai-badge{background:var(--cc-surface);color:var(--cc-accent-ink);border:1px solid var(--cc-border);animation:none}
 .ai-badge .dot{background:var(--cc-accent);box-shadow:none}
 .reset-btn,.settings-btn,.footer{color:var(--cc-muted)}
 .reset-btn:hover{background:var(--cc-surface);color:var(--cc-text)}
 .chip{background:var(--cc-chip-bg);color:var(--cc-chip-text);border:1px solid var(--cc-border);border-radius:var(--cc-control-radius);box-shadow:var(--cc-key-shadow)}
 .chip:hover{background:var(--cc-surface);color:var(--cc-text);border-color:var(--cc-accent);box-shadow:var(--cc-key-shadow);transform:translateY(-1px)}
 .chip:active,.send-btn:active{transform:translateY(1px);box-shadow:none}
 .chat-container{border-top-color:var(--cc-border)}
 .chat-history::-webkit-scrollbar-thumb{background:var(--cc-border)}
 .message{border-radius:14px}.message.ai{border-radius:14px!important}
 .message.user{background:var(--cc-accent);color:var(--cc-on-accent);border:1px solid var(--cc-border);box-shadow:var(--cc-key-shadow)}
 .message.ai,.loader{background:var(--cc-surface);color:var(--cc-text);border:1px solid var(--cc-border);border-radius:var(--cc-control-radius);box-shadow:var(--cc-key-shadow)}
 .loader-dot{background:var(--cc-muted)}
 .input-field{background:var(--cc-bg);color:var(--cc-text);border:1px solid var(--cc-border);border-radius:var(--cc-control-radius);box-shadow:var(--cc-key-shadow);min-width:0}
 .input-field::placeholder{color:var(--cc-muted);opacity:1}
 .input-field:focus{border-color:var(--cc-accent);box-shadow:0 0 0 3px var(--cc-focus-ring)}
 .send-btn{background:var(--cc-accent);color:var(--cc-on-accent);border:1px solid var(--cc-border);border-radius:50%;box-shadow:var(--cc-key-shadow)}
 .send-btn:hover{background:var(--cc-accent);filter:brightness(.97);box-shadow:var(--cc-key-shadow)}
 .send-btn:disabled{background:var(--cc-surface);color:var(--cc-muted);box-shadow:none;filter:none}
 .send-btn svg{color:inherit;stroke:currentColor}
 .settings-modal{background:var(--cc-bg);color:var(--cc-text);border-radius:var(--cc-radius)}
 .settings-group label{color:var(--cc-text)}
 .settings-group input[type="text"],.settings-group select{background:var(--cc-surface);color:var(--cc-text);border:1px solid var(--cc-border);border-radius:var(--cc-control-radius)}
 .settings-save-btn{background:var(--cc-accent);color:var(--cc-on-accent);border-radius:var(--cc-control-radius);box-shadow:var(--cc-key-shadow)}
 .discount-banner{background:var(--cc-surface);border-color:var(--cc-border);border-radius:var(--cc-control-radius);color:var(--cc-text)}
 .discount-title,.discount-close{color:var(--cc-text)}
 .discount-code{background:var(--cc-bg);border-color:var(--cc-accent);color:var(--cc-text)}
 .chip:focus-visible,.send-btn:focus-visible{outline:2px solid var(--cc-accent-ink);outline-offset:3px}
 @media(prefers-reduced-motion:reduce){.widget-container *{animation:none!important;transition:none!important}}
 `;
 function apply(element,preset,color){const t=tokens(preset,color);for(const[k,v]of Object.entries(t.values))element.style.setProperty('--cc-'+k,v);element.setAttribute('data-cc-theme',t.preset);return t;}
 const api={PRESETS,CSS,normalize,isPreset,tokens,apply,contrast};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ClarityCartThemes=api;
})(typeof window==='undefined'?globalThis:window);
