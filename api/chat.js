export default async function handler(req, res) {
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
  if (!apiKey) return res.status(200).json({ answer: '⚠️ Error: API Key is not configured.' });

  try {
    const { question, domain, store_domain, productContext, systemInstruction, temperature } = req.body || {};
    const targetDomain = (domain || store_domain || '').trim().toLowerCase();

    // Check store quota & block status via Supabase
    if (targetDomain && targetDomain !== 'unknown') {
      try {
        const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vzmpwstfddznsvypudhj.supabase.co';
        const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6bXB3c3RmZGR6bnN2eXB1ZGhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NzMyMTksImV4cCI6MjEwNjM0OTIxOX0.Qz0TGEDy1TOekLrqTrfspT8gnnfGy5_BjMtJRlz-PaI';
        const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

        let isBlocked = false;
        let queryLimit = 500;

        // If service key is available, check live user metadata
        if (SUPABASE_SERVICE_KEY) {
          const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
          });
          if (authRes.ok) {
            const authData = await authRes.json();
            const user = (authData.users || []).find(u => (u.user_metadata?.store_domain || '').trim().toLowerCase() === targetDomain);
            if (user) {
              const meta = user.user_metadata || {};
              isBlocked = Boolean(user.banned_until && new Date(user.banned_until) > new Date()) || Boolean(meta.is_blocked);
              const plan = (meta.plan || '').toLowerCase();
              queryLimit = meta.query_limit || (plan === 'pro' ? 5000 : plan === 'business' ? 15000 : 500);
            }
          }
        }

        if (isBlocked) {
          return res.status(200).json({
            answer: "This store's AI assistant has been temporarily suspended by the administrator.",
            blocked: true
          });
        }

        // Count questions for this domain
        const countRes = await fetch(`${SUPABASE_URL}/rest/v1/questions?store_domain=eq.${encodeURIComponent(targetDomain)}&select=id`, {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Range': '0-0',
            'Prefer': 'count=exact'
          }
        });
        const contentRange = countRes.headers.get('content-range');
        const totalCount = contentRange ? parseInt(contentRange.split('/')[1], 10) : 0;

        if (!isNaN(totalCount) && totalCount >= queryLimit) {
          return res.status(200).json({
            answer: "Monthly AI query limit reached for this store. Please upgrade your plan in your ClarityCart dashboard.",
            limitReached: true,
            queryCount: totalCount,
            queryLimit: queryLimit
          });
        }
      } catch (checkErr) {
        console.warn('[Vercel API] Limit check error (failing open):', checkErr.message);
      }
    }
    const basePrompt = systemInstruction ? `${systemInstruction}\n\n` : '';
    const strictConstraint = "CRITICAL DIRECTIVE: You are an AI sales assistant exclusively for this e-commerce store. Your primary goal is to SELL the product. If the user asks a general off-topic question (like coding, weather, history), politely decline. If the user asks for a comparison between our product and a competitor's product (e.g., Apple vs Sony), you MUST answer by heavily highlighting the advantages of OUR product and gently explaining why OUR product is the better choice. Do not refuse comparisons, but ALWAYS be biased towards our store's item. ";
    const fullSystemInstruction = `${basePrompt}${strictConstraint}`;
    const promptText = `Product: "${productContext?.title || 'Unknown'}". Details: ${productContext?.description || 'None'}. Price: ${productContext?.price || 'Unknown'}. User Question: "${question}". Answer concisely in 1-2 sentences.`;

    const modelPriority = [
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-flash-latest'
    ];

    let lastError = null;

    for (const model of modelPriority) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            system_instruction: { parts: [{ text: fullSystemInstruction }] },
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
              temperature: temperature !== undefined ? parseFloat(temperature) : 0.7
            }
          })
        });

        const data = await response.json();

        if (response.ok && data.candidates) {
          return res.status(200).json({ 
            answer: data.candidates[0].content.parts[0].text,
            usedModel: model // Return used model for analytics
          });
        } else {
          lastError = data.error?.message;
        }
      } catch (err) {
        lastError = err.message;
      }
    }

    return res.status(200).json({ answer: `⚠️ No available models. Last error: ${lastError}` });
  } catch (error) {
    return res.status(200).json({ answer: `⚠️ ${error.message}` });
  }
}
