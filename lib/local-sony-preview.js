module.exports=function localSonyPreview(req,binding,providerFailed=false){
    const hasKey=Boolean(process.env.GEMINI_API_KEY?.trim());
    const localOrigin=/^http:\/\/(?:localhost|127\.0\.0\.1):3000$/.test(req.headers.origin || '');
    if((hasKey && !providerFailed) || !localOrigin || binding.kind!=='preview')return null;

    const question=req.body.question;
    let answer='The demo page does not provide that detail for the Sony WH-1000XM5.';
    if(/key features|main features|особенност/i.test(question)){
        answer='The demo lists noise cancellation with two processors and eight microphones, up to 30 hours of battery life, and quick charging.';
    } else if(/battery|charg|автоном|батаре|заряд/i.test(question)){
        answer='The demo lists up to 30 hours of battery life and supports quick charging.';
    } else if(/noise|microphone|шум|микрофон/i.test(question)){
        answer='The demo lists noise cancellation with two processors and eight microphones.';
    } else if(/price|cost|цен|стои/i.test(question)){
        answer='The demo price is $399.00.';
    }
    return {answer:'Local Sony demo: '+answer,usedModel:'local-sony-demo',demo:true,usageRecorded:false};
};
