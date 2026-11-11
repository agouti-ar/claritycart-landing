const {serverDb}=require('../lib/store-access');
const {rate,clientIp}=require('../lib/request-security');

module.exports=async function waitlist(req,res){
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
    const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
    if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'INVALID_EMAIL'});
    try {
        const db=serverDb();
        await rate(db,'waitlist:'+clientIp(req),5);
        const {error}=await db.from('cc_waitlist').upsert({email},{onConflict:'email',ignoreDuplicates:true}).abortSignal(AbortSignal.timeout(5000));
        if(error)throw error;
        return res.status(200).json({ok:true});
    } catch(error) {
        const status=error.status===429?429:503;
        return res.status(status).json({error:status===429?'RATE_LIMITED':'WAITLIST_UNAVAILABLE'});
    }
};
