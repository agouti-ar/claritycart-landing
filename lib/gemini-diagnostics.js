// Provider diagnostics stay server-side. Never log credentials or merchant/buyer text.
function providerDiagnostic(error,{apiKey='',redact=[],model,httpStatus,elapsedMs,category}={}) {
 let message=typeof error?.message==='string'?error.message:'No provider error message';
 for(const value of [apiKey,...redact])if(typeof value==='string'&&value)message=message.split(value).join('[REDACTED]');
 message=message.replace(/AIza[A-Za-z0-9_-]{20,}/g,'[REDACTED]')
  .replace(/([?&](?:key|api_key|token)=)[^&\s"'<>]+/gi,'$1[REDACTED]')
  .replace(/[\r\n\t]/g,' ').slice(0,800);
 const code=typeof error?.code==='number'?error.code:undefined;
 const status=typeof error?.status==='string'&&/^[A-Z_]{1,60}$/.test(error.status)?error.status:undefined;
 const reasons=Array.isArray(error?.details)?error.details.map(d=>d?.reason).filter(v=>typeof v==='string'&&/^[A-Z_]{1,80}$/.test(v)).slice(0,5):[];
 return {model,httpStatus,category,elapsedMs,code,status,reasons,message};
}
module.exports={providerDiagnostic};
