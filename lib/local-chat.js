// Without a local AI key, the remote server owns both generation and usage.
// No local insert is performed on this proxy path.
function createLocalChatHandler(handler, options = {}) {
  return async (req, res) => {
    if (options.hasApiKey ?? Boolean(process.env.GEMINI_API_KEY?.trim())) {
      return handler(req, res);
    }
    try {
      const upstream = await (options.fetch || fetch)('https://claritycart-landing.vercel.app/api/' + (options.endpoint || 'chat'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(req.headers?.origin ? {Origin:req.headers.origin} : {}), ...(req.headers?.authorization ? {Authorization:req.headers.authorization} : {}) },
        body: JSON.stringify(req.body), signal: AbortSignal.timeout(45000)
      });
      const body = await upstream.json();
      // An older deployment cannot safely act as the authoritative writer.
      if ((!options.endpoint || options.endpoint === 'chat') && upstream.ok && (!body.requestId || body.usageRecorded === undefined)) {
        return res.status(503).json({ error: 'UPSTREAM_VERSION_MISMATCH', retryable: true, answer: 'The remote API needs the usage update. Please contact the store.' });
      }
      return res.status(upstream.status).json(body);
    } catch (error) {
      return res.status(503).json({ error: 'UPSTREAM_UNAVAILABLE', retryable: true, answer: 'The request could not be confirmed. Please retry the same question.' });
    }
  };
}
module.exports = { createLocalChatHandler };
