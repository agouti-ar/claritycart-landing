(function(root){
 'use strict';
 const clientOptions={auth:{flowType:'pkce',detectSessionInUrl:true}};
 const callbackUrl=origin=>new URL('/auth-callback.html',origin).href;
 const storeKey=userId=>'cc-selected-store:'+userId;
 async function finishCallback({auth,location,history}){
   const url=new URL(location.href);
   const failed=url.searchParams.has('error')||new URLSearchParams(url.hash.slice(1)).has('error');
   try {
     // Supabase performs the single PKCE exchange during client initialization.
     const {data,error}=await auth.getSession();
     if(failed||error||!data?.session)throw new Error('Sign-in could not be completed. Please start again in the same browser.');
     const verified=await auth.getUser();
     if(verified.error||!verified.data?.user)throw new Error('Your session could not be verified. Please sign in again.');
     location.replace(url.searchParams.get('next') === 'test' ? 'test.html' : 'onboarding.html');
   } finally {history.replaceState({},'',url.pathname);}
 }
 async function onboardingRequest({auth,fetch,base='',body}){
   const {data,error}=await auth.getSession();
   if(error||!data?.session)throw new Error('Please sign in again.');
   const response=await fetch(base+'/api/account'+(body?'':'?list=1'),{
     method:body?'POST':'GET',headers:{Authorization:'Bearer '+data.session.access_token,'Content-Type':'application/json'},
     ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)
   });
   const result=await response.json();
   if(!response.ok){const messages={DOMAIN_UNAVAILABLE:'This domain is unavailable. Contact support if you own it.',INVALID_STORE_DOMAIN:'Enter a valid store hostname without a URL path.',EMAIL_CONFIRMATION_REQUIRED:'Confirm your email before creating a store.',RATE_LIMITED:'Too many attempts. Please wait a minute.'};throw new Error(messages[result.error]||'Store setup is unavailable. Your existing stores have not changed.');}
   return {result,userId:data.session.user.id};
 }
 const api={clientOptions,callbackUrl,storeKey,finishCallback,onboardingRequest};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ClarityAuth=api;
})(typeof window==='undefined'?globalThis:window);
