const { createUsageHandler } = require('../lib/usage-handler');
const { providerDiagnostic } = require('../lib/gemini-diagnostics');
const groundingAdapter=require('../lib/grounding');

async function generateResponse(req, res) {
  // CORS and Anti-cache headers
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  // Production security: replace '*' with allowed domains (e.g. 'https://yourstore.com')
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // Block all methods except POST (Security)
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  let apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!apiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED', answer: 'The AI service is not configured.' });

  try {
    const { question, productContext, temperature } = req.body || {};
    // Entitlement and merchant preferences are supplied only by the successful DB reservation.
    const entitlement = req.entitlement;
    if (!entitlement?.plan) return res.status(503).json({ error: 'ENTITLEMENT_UNAVAILABLE', answer: 'Store access could not be verified.' });
    const settings = entitlement.settings || {};
    const {voice,system:fullSystemInstruction}=require('../lib/ai-adapter').buildInstructions(entitlement);
    const grounding=req.grounding||groundingAdapter.compose(productContext,null,req.body?.domain||'',question);
    const promptText=groundingAdapter.prompt(question,grounding,req.body?.history,voice.custom_instructions);

    const modelPriority = [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash'
    ];

    const redact=[question,productContext?.title,productContext?.description,productContext?.price,settings.custom_tone_prompt,settings.custom_instructions,promptText];
    const diagnose=(error,details)=>console.warn('[Gemini]',JSON.stringify(providerDiagnostic({...error,message:'Provider request failed (content omitted)'},{apiKey,redact,...details})));

    for (const model of modelPriority) {
      const started=Date.now();let httpStatus;
      // A slow first model must not consume the handler's entire 25s deadline.
      const attempt=new AbortController();
      const attemptTimer=setTimeout(()=>attempt.abort(),8000);
      const signal=req.signal?AbortSignal.any([req.signal,attempt.signal]):attempt.signal;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            system_instruction: { parts: [{ text: fullSystemInstruction }] },
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
              temperature: temperature !== undefined ? parseFloat(temperature) : 0.7,
              thinkingConfig: { thinkingLevel: 'low' },
              maxOutputTokens: 512
            }
          })
        });
        httpStatus=response.status;

        const data = await response.json();

        if (response.ok && typeof data.candidates?.[0]?.content?.parts?.[0]?.text === 'string' && data.candidates[0].content.parts[0].text.trim()) {
          return res.status(200).json({ 
            answer: data.candidates[0].content.parts[0].text,
            usedModel: model, // Return used model for analytics
            grounding: {mode:grounding.mode,source:grounding.source,conflicts:grounding.conflicts,missing:grounding.missing}
          });
        } else {
          diagnose(data.error||{message:'Empty or blocked provider response'},{model,httpStatus,elapsedMs:Date.now()-started,category:data.error?'provider_error':'empty_response'});
        }
      } catch (err) {
        diagnose(err,{model,httpStatus,elapsedMs:Date.now()-started,category:req.signal?.aborted?'request_aborted':attempt.signal.aborted?'model_timeout':'transport_or_parse_error'});
        if (req.signal?.aborted) throw err;
      } finally {
        clearTimeout(attemptTimer);
      }
    }

    return res.status(502).json({ error: 'AI_UNAVAILABLE', answer: 'The AI service could not answer. Please try again.' });
  } catch (error) {
    return res.status(502).json({ error: 'AI_UNAVAILABLE', answer: 'The AI service could not answer. Please try again.' });
  }
}

module.exports = createUsageHandler(generateResponse);
module.exports.generateResponse = generateResponse;
