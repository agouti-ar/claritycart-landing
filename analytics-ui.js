(function(root){
 'use strict';
 async function read({auth,storeId,base='',fetch:request=root.fetch.bind(root)}){
  const {data,error}=await auth.getSession();if(error||!data?.session)throw new Error('AUTH_REQUIRED');
  const response=await request(base+'/api/events?store_id='+encodeURIComponent(storeId),{headers:{Authorization:'Bearer '+data.session.access_token},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('ANALYTICS_UNAVAILABLE');return response.json();
 }
 function render(document,metrics){
  const put=(id,value)=>{
   const element=document.getElementById(id);
   if(element && element.textContent!==value)element.textContent=value;
  };
  for(const [id,key] of Object.entries({'total-questions':'questions_answered','analytics-questions':'questions_answered','analytics-sessions':'sessions','analytics-visitors':'visitors','analytics-views':'product_views','metric-engaged':'engaged_visitors','metric-cart':'cart_additions'}))put(id,metrics&&Number.isFinite(metrics[key])?metrics[key].toLocaleString():'0');
  const seconds=metrics?.estimated_time_saved_seconds;
  const time=Number.isFinite(seconds)?(seconds<3600?(seconds/60).toLocaleString('en-US')+' mins':(seconds/3600).toFixed(1)+' hrs'):'0 mins';
  put('time-saved',time);put('analytics-time-saved',time);put('metric-revenue','Not connected');
  put('analytics-status',metrics?'Last 30 days · recorded storefront activity · estimated time saved: 2.5 min per confirmed answer.' + (metrics.unclassified_answers ? ' ' + metrics.unclassified_answers + ' older/unclassified answers excluded.' : ''):'Analytics unavailable. Existing usage and access are unchanged.');
 }
 const api={read,render};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ClarityMetrics=api;
})(typeof window==='undefined'?globalThis:window);
