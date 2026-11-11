(function(root){
 'use strict';
 function mountBrandVoice({document,settings={},canCustomize=false,save,onSaved=()=>{}}){
  const form=document.getElementById('brand-voice-form'),tone=document.getElementById('brand-voice-tone'),custom=document.getElementById('custom-instructions'),status=document.getElementById('brand-voice-status'),button=document.getElementById('brand-voice-save'),counter=document.getElementById('brand-voice-counter');
  let busy=false, baseline;
  const current=()=>JSON.stringify([tone.value,custom.value]);
  function updateButton(){button.disabled=!canCustomize||busy||current()===baseline;}
  function load(value={}){
   const selected=['friendly','formal','concise','professional','sales','custom'].includes(value.tone)?value.tone:value.friendly_tone===false?'professional':'friendly';
   tone.value=selected;custom.value=typeof value.custom_instructions==='string'?value.custom_instructions:(selected==='custom'?value.custom_tone_prompt||'':'');
   if(custom.value.length>400)custom.value=custom.value.slice(0,400);
   if(counter)counter.textContent=custom.value.length+'/400';
   baseline=current();updateButton();
  }
  load(settings);tone.disabled=custom.disabled=!canCustomize;updateButton();
  tone.addEventListener('change',updateButton);
  status.textContent=canCustomize?'Tone changes presentation only. Product facts stay grounded.':'Custom Brand Voice is available on Pro and Business. Saved preferences stay intact.';
  custom.addEventListener('input',()=>{if(counter)counter.textContent=custom.value.length+'/400';updateButton();});
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(busy||!canCustomize||current()===baseline)return;busy=true;tone.disabled=custom.disabled=button.disabled=true;status.textContent='Saving Brand Voice…';
   try{
    const requested={tone:tone.value,custom_instructions:custom.value};
    const account=await save(requested);const actual=account.settings;
    if(!actual||typeof actual.tone!=='string'||typeof actual.custom_instructions!=='string')throw new Error('Server did not confirm saved preferences.');
    load(actual);status.textContent=actual.custom_instructions!==requested.custom_instructions?'Saved. Unsafe instructions or formatting were removed.':'Brand Voice saved.';
    onSaved(actual);
   }catch(error){status.textContent='Could not save Brand Voice: '+error.message;}
   finally{busy=false;tone.disabled=custom.disabled=!canCustomize;updateButton();}
  });
  return {load};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={mountBrandVoice};else root.mountBrandVoice=mountBrandVoice;
})(typeof window==='undefined'?globalThis:window);
