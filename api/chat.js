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
    const { question, productContext, systemInstruction, temperature } = req.body || {};
    const basePrompt = systemInstruction ? `${systemInstruction}\n\n` : '';
    const strictConstraint = "STRICT RULE: You are an AI assistant exclusively for this e-commerce store. You MUST ONLY answer questions related to the store, shipping, returns, or the specific product mentioned below. If the user asks about ANYTHING ELSE (like general comparisons, 'what is better apple or sony', general knowledge, coding, weather, etc.), politely decline and steer the conversation back to the product. DO NOT provide general advice or info outside the context of buying this exact item. ";
    const promptText = `${basePrompt}${strictConstraint}Product: "${productContext?.title || 'Unknown'}". Details: ${productContext?.description || 'None'}. Price: ${productContext?.price || 'Unknown'}. User Question: "${question}". Answer concisely in 1-2 sentences.`;

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
