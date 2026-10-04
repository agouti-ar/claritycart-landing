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
