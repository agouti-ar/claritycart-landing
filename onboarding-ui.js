(function(root){
 'use strict';
 function mountOnboarding(options){
   const {document,auth,storage,location}=options;
   const flow=options.flow||root.ClarityAuth;
   const status=document.getElementById('status'),list=document.getElementById('stores'),form=document.getElementById('store-form'),input=document.getElementById('domain'),button=document.getElementById('create-store');
   let busy=false;
   const select=(store,userId)=>{storage.setItem(flow.storeKey(userId),store.id);storage.removeItem('cc-domain-draft');location.replace('dashboard.html');};
   const call=body=>flow.onboardingRequest({...options,body});
   form.addEventListener('submit',async event=>{
     event.preventDefault();if(busy)return;busy=true;button.disabled=true;
     try{const {result,userId}=await call({store_domain:input.value.trim()});select(result.store,userId);}
     catch(error){status.textContent=error.message;}
     finally{busy=false;button.disabled=false;}
   });
   const ready=(async()=>{
     try{
       const {data,error}=await auth.getSession();
       if(error||!data?.session){location.replace('login.html');return;}
       input.value=storage.getItem('cc-domain-draft')||'';
       const {result,userId}=await call();
       for(const store of result.stores){
         const choose=document.createElement('button');choose.type='button';choose.textContent=store.domain+' — '+store.status;
         choose.addEventListener('click',()=>{if(!busy)select(store,userId);});list.appendChild(choose);
       }
       status.textContent=result.stores.length?'Select a store to continue.':'Connect your first store.';
     }catch(error){status.textContent=error.message;}
   })();
   return {ready};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={mountOnboarding};else root.mountOnboarding=mountOnboarding;
})(typeof window==='undefined'?globalThis:window);
