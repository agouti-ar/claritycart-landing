const { createHash, randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { validateChatBody, authorizeWidget, cors, RequestError } = require('./request-security');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

function createUsageHandler(generate, options = {}) {
  return async function usageHandler(req, res) {
    cors(req,res);
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    try { validateChatBody(req.body); } catch(error) { return res.status(error.status || 400).json({error:error.code || 'INVALID_REQUEST',answer:'Please check your question and product details.'}); }
    const body = req.body || {};
    const domain = typeof (body.domain || body.store_domain) === 'string' ? (body.domain || body.store_domain).trim().toLowerCase() : '';
    if (!uuid.test(body.request_id || '') || !domain || domain === 'unknown' || typeof body.question !== 'string' || !body.question.trim()) {
      return res.status(400).json({ error: 'INVALID_REQUEST', answer: 'A store, question and valid request ID are required.' });
    }
    // Only inputs actually used by generation participate in the replay identity.
    const payload = { domain, question: body.question.trim(), productContext: body.productContext || {}, systemInstruction: body.systemInstruction || '', temperature: body.temperature ?? 0.7 };
    if(Array.isArray(body.history)&&body.history.length)payload.history=body.history;
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
    const owner = randomUUID();
    let db;
    const rpc = async (name, args) => {
      const { data, error } = await db.rpc(name, args).abortSignal(AbortSignal.timeout(options.dbTimeoutMs || 8000));
      if (error) throw error;
      return data;
    };
    try {
      db = options.db || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const binding = await (options.authorize || authorizeWidget)(req, db);
      const demo = options.localPreview?.(req,binding);
      if(demo)return res.status(200).json(demo);
      const claim = await rpc(binding.storeId ? 'claim_verified_chat_request' : 'claim_chat_request', { p_request_id: body.request_id, p_domain: domain, p_fingerprint: fingerprint, p_owner: owner, ...(binding.storeId ? {p_store_id:binding.storeId,p_widget_epoch:binding.epoch} : {}) });
      if(claim.state==='denied' && ['ACCESS_INACTIVE','QUOTA_EXHAUSTED'].includes(claim.error)){
        const fallback = options.localPreview?.(req,binding,true);
        if(fallback)return res.status(200).json(fallback);
      }
      if (claim.state === 'denied') return res.status(claim.http_status || 403).json({ error: claim.error, answer: claim.error === 'ACCESS_INACTIVE' ? 'This store has no active access period. Check its status and expiration in the dashboard.' : claim.error === 'QUOTA_EXHAUSTED' ? 'This store has used its available answers.' : 'The store AI assistant is unavailable (' + claim.error + ').', blocked: true, usageRecorded: false });
      if (claim.state === 'conflict') return res.status(409).json({ error: 'REQUEST_ID_CONFLICT', answer: 'This request ID belongs to a different request.' });
      if (claim.state === 'completed') return res.status(claim.http_status).json(claim.response);
      if (claim.state !== 'claimed') return res.status(409).json({ error: 'REQUEST_PENDING', retryable: true, answer: 'Your previous request is still being processed. Please retry the same question shortly.' });

      // Telemetry is independent of authoritative usage. Never block AI if its optional migration is absent.
      if (binding.kind) {
        try {
          const {analyticsIdentity,uuid}=require('./events-handler');
          const a=body.analytics;
          const valid=a&&uuid(a.visitor_id)&&uuid(a.session_id);
          const {error:analyticsError}=await db.rpc('bind_cc_chat_analytics',{p_request:body.request_id,p_worker:owner,p_store:binding.storeId,p_epoch:binding.epoch,p_preview:binding.kind==='preview',
            p_visitor:valid?analyticsIdentity(a.visitor_id,binding.storeId):null,p_session:valid?a.session_id:null}).abortSignal(AbortSignal.timeout(1200));
          if(analyticsError)throw analyticsError;
        } catch(error) { console.warn('[Analytics] Chat context unavailable:',error.code||error.name); }
      }

      let result, status = 200;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.aiTimeoutMs || 25000);
      const capture = { setHeader() {}, status(code) { status = code; return this; }, json(value) { result = value; return this; } };
      try {
        const grounding=await require('./grounding').loadGrounding(db,{...binding,domain},payload.productContext,payload.question,controller.signal);
        await generate({ ...req, body: { ...payload, request_id: body.request_id }, signal: controller.signal, entitlement: claim, grounding, widgetBinding: binding }, capture);
        if (controller.signal.aborted) throw new Error('AI_TIMEOUT');
        if (!result || typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('EMPTY_AI_RESPONSE');
      } catch (error) {
        status = controller.signal.aborted ? 504 : 502;
        result = { error: controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', answer: 'The AI service could not answer. Please try again.' };
      } finally {
        clearTimeout(timer);
      }
      const recorded = status >= 200 && status < 300 && !result.error && !result.blocked && !result.limitReached;
      result = { ...result, requestId: body.request_id, usageRecorded: recorded };
      // Completion and questions INSERT are one transaction. Never return success before commit.
      const completed = await rpc('complete_chat_request', {
        p_request_id: body.request_id, p_owner: owner, p_response: result, p_http_status: status,
        p_record_usage: recorded, p_question: payload.question,
        p_product_context: typeof payload.productContext.title === 'string' ? payload.productContext.title : ''
      });
      if(completed.http_status >= 500){
        const fallback = options.localPreview?.(req,binding,true);
        if(fallback)return res.status(200).json(fallback);
      }
      return res.status(completed.http_status).json(completed.response);
    } catch (error) {
      if(error instanceof RequestError) { if(error.status===429)res.setHeader('Retry-After','60'); return res.status(error.status).json({error:error.code,answer:error.status===429?'Too many requests. Please try again shortly.':'Store access could not be verified.',usageRecorded:false}); }
      // An ambiguous DB timeout must not trigger another generation with a new ID.
      console.warn('[Usage] Request persistence unavailable:', error.code || error.name || 'database error');
      return res.status(503).json({ error: 'USAGE_UNAVAILABLE', retryable: true, answer: 'We could not confirm this request. Please retry the same question shortly.' });
    }
  };
}

module.exports = { createUsageHandler };
