require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Enable CORS for frontend requests
app.use(cors({
  origin: '*' // In production, this can be restricted to your domain
}));

// Parse JSON request bodies
app.use(express.json());

// Initialize Supabase with the SERVICE_ROLE key to bypass RLS restrictions securely on the server
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Admin emails allowed to access management endpoints
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'darksteel180@gmail.com,lordlymonk@gmail.com')
  .split(',')
  .map(e => e.trim().toLowerCase());

// Middleware to verify Supabase JWT token and ensure the caller is an Admin
async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired session token' });
    }

    const userEmail = (user.email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(userEmail)) {
      return res.status(403).json({ error: 'Access denied: Admin privileges required' });
    }

    req.adminUser = user;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Authentication check failed', details: err.message });
  }
}

// --- API ENDPOINTS ---

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'ClarityCart API is running!' });
});

// Domain validation endpoint
app.post('/api/validate-domain', async (req, res) => {
  const { domain } = req.body;
  
  if (!domain) {
    return res.status(400).json({ valid: false, error: 'Domain is required' });
  }

  // Basic syntax check for a domain
  const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/;
  if (!domainPattern.test(domain)) {
    return res.status(400).json({ valid: false, error: 'Invalid domain format (e.g. mystore.com)' });
  }

  console.log(`[Backend] Validating domain: ${domain}... OK!`);
  res.json({ valid: true, message: 'Domain is valid' });
});

// Friendly, customer-safe resting messages when AI quota is reached or store is paused
function getRandomRestingMessage(isRussian = false) {
  const ruMessages = [
    "Наш AI-помощник сейчас на коротком кофе-брейке ☕ после общения со столькими покупателями сегодня! Вы можете продолжить покупки или оформить заказ, наша команда на связи.",
    "Кажется, наш консультант ненадолго отвлекся на подзарядку батареек 🔋! Вы можете добавить товар в корзину или написать нашим менеджерам.",
    "Наш электронный специалист на пару минут отошел за свежим чаем 🍵. Оформите заказ на сайте или напишите в поддержку — мы на связи!",
    "Наш AI-консультант устроил небольшую передышку 🛋️! Вы можете смело завершить покупку или задать вопрос оператору."
  ];

  const enMessages = [
    "Our AI assistant is taking a short coffee break ☕ after chatting with so many shoppers today! Feel free to explore or complete your order directly.",
    "Our digital specialist is briefly recharging batteries 🔋! You can proceed to checkout or reach out to our support team.",
    "Our store assistant stepped away for a fresh cup of tea 🍵. You can safely add items to your cart or contact our staff!",
    "Looks like our AI consultant is taking a quick breather 🛋️! Feel free to continue shopping or message our team."
  ];

  const list = isRussian ? ruMessages : enMessages;
  return list[Math.floor(Math.random() * list.length)];
}

// Helper to check if a store domain is blocked or exceeded quota
async function checkStoreLimit(domain, question = '') {
  if (!domain || domain === 'unknown') {
    return { allowed: true };
  }
  const cleanDomain = domain.trim().toLowerCase();
  const isRussian = /[а-яё]/i.test(question || '');

  try {
    // 1. Fetch user list from Supabase Admin
    const { data: authData, error: usersError } = await supabase.auth.admin.listUsers();
    if (usersError || !authData?.users) {
      console.warn('[CheckLimit] Failed to list users:', usersError);
      return { allowed: true };
    }

    const user = authData.users.find(u => {
      const metaDomain = (u.user_metadata?.store_domain || '').trim().toLowerCase();
      return metaDomain === cleanDomain;
    });

    if (!user) {
      // Store not found among registered accounts (e.g. unregistered trial)
      return { allowed: true };
    }

    const meta = user.user_metadata || {};
    const isBlocked = Boolean(user.banned_until && new Date(user.banned_until) > new Date()) || 
                      Boolean(meta.is_blocked) || 
                      Boolean(meta.widget_paused);
    if (isBlocked) {
      return {
        allowed: false,
        reason: 'blocked',
        message: getRandomRestingMessage(isRussian)
      };
    }

    // 2. Count questions for this domain in Supabase
    const { count, error: countErr } = await supabase
      .from('questions')
      .select('*', { count: 'exact', head: true })
      .eq('store_domain', cleanDomain);

    const queryCount = count || 0;
    let queryLimit = meta.query_limit;
    if (!queryLimit) {
      const plan = (meta.plan || '').toLowerCase();
      if (plan === 'pro') queryLimit = 5000;
      else if (plan === 'business') queryLimit = 15000;
      else if (plan === 'enterprise') queryLimit = 50000;
      else queryLimit = 500;
    }

    // Since questions are only recorded after a successful AI response,
    // queryCount >= queryLimit accurately blocks new requests once quota is reached.
    if (queryCount >= queryLimit) {
      return {
        allowed: false,
        reason: 'limit_reached',
        queryCount,
        queryLimit,
        message: getRandomRestingMessage(isRussian)
      };
    }

    return { allowed: true, queryCount, queryLimit };
  } catch (err) {
    console.error('[CheckLimit] Error checking limit:', err);
    return { allowed: true };
  }
}

// Chat API endpoint (with quota & block protection)
app.post('/api/chat', async (req, res) => {
  const { question, domain, store_domain, productContext, systemInstruction, temperature, model } = req.body || {};
  const targetDomain = domain || store_domain;

  // 1. Quota & block check
  const status = await checkStoreLimit(targetDomain, question);
  if (!status.allowed) {
    console.log(`[Chat API] Protected block for domain "${targetDomain}". Reason: ${status.reason}`);
    return res.status(200).json({
      answer: status.message,
      limitReached: status.reason === 'limit_reached',
      blocked: status.reason === 'blocked',
      queryCount: status.queryCount,
      queryLimit: status.queryLimit
    });
  }

  // 2. If allowed, generate response via Gemini or proxy to Vercel Gemini
  let apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!apiKey) {
    // Proxy to Vercel production endpoint
    try {
      const vercelRes = await fetch('https://claritycart-landing.vercel.app/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body)
      });
      const data = await vercelRes.json();
      return res.status(vercelRes.status).json(data);
    } catch (proxyErr) {
      return res.status(200).json({ answer: "⚠️ Could not reach AI service." });
    }
  }

  // Local Gemini call
  try {
    const basePrompt = systemInstruction ? `${systemInstruction}\n\n` : '';
    const strictConstraint = "CRITICAL DIRECTIVE: You are an AI sales assistant exclusively for this e-commerce store. Your primary goal is to SELL the product. If the user asks a general off-topic question, politely decline. Answer concisely in 1-2 sentences.";
    const fullSystemInstruction = `${basePrompt}${strictConstraint}`;
    const promptText = `Product: "${productContext?.title || 'Unknown'}". Details: ${productContext?.description || 'None'}. Price: ${productContext?.price || 'Unknown'}. User Question: "${question}". Answer concisely in 1-2 sentences.`;

    const modelPriority = [model || 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
    let lastError = null;

    for (const m of modelPriority) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
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
            usedModel: m
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
});

// Admin: Get overview data (all users, usage counts, platform stats)
app.get('/api/admin/overview', authenticateAdmin, async (req, res) => {
  try {
    // 1. Fetch all registered users via Supabase Admin API
    const { data: authData, error: usersError } = await supabase.auth.admin.listUsers();
    if (usersError) throw usersError;

    // 2. Fetch all questions from the database for usage metrics
    const { data: questions, error: qError } = await supabase
      .from('questions')
      .select('id, store_domain, created_at');
    if (qError) throw qError;

    const allQuestions = questions || [];
    
    // Group queries by store_domain
    const domainCounts = {};
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let todayQueriesCount = 0;
    allQuestions.forEach(q => {
      if (q.store_domain) {
        domainCounts[q.store_domain] = (domainCounts[q.store_domain] || 0) + 1;
      }
      if (q.created_at && new Date(q.created_at) >= todayStart) {
        todayQueriesCount++;
      }
    });

    // 3. Process each user
    let activeSubs = 0;
    let totalMRR = 0;

    const users = authData.users.map(u => {
      const meta = u.user_metadata || {};
      const storeDomain = meta.store_domain || 'not-connected.com';
      const plan = meta.plan || (storeDomain === 'my-super-shoes.com' ? 'Pro' : 'Starter');
      
      let queryLimit = meta.query_limit || 500;
      let planPrice = 0;

      if (plan.toLowerCase() === 'pro') {
        if (!meta.query_limit) queryLimit = 5000;
        planPrice = 29;
      } else if (plan.toLowerCase() === 'business') {
        if (!meta.query_limit) queryLimit = 15000;
        planPrice = 79;
      } else if (plan.toLowerCase() === 'enterprise') {
        if (!meta.query_limit) queryLimit = 50000;
        planPrice = 199;
      }

      const queryCount = domainCounts[storeDomain] || 0;
      const isBlocked = Boolean(u.banned_until && new Date(u.banned_until) > new Date()) || Boolean(meta.is_blocked);
      
      if (!isBlocked) {
        activeSubs++;
        totalMRR += planPrice;
      }

      // Calculate days remaining in subscription
      let daysRemaining = 30; // default
      if (meta.subscription_expires_at) {
        const diffMs = new Date(meta.subscription_expires_at) - new Date();
        daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      }

      return {
        id: u.id,
        email: u.email,
        store_domain: storeDomain,
        plan: plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase(),
        query_count: queryCount,
        query_limit: queryLimit,
        is_blocked: isBlocked,
        widget_paused: Boolean(meta.widget_paused),
        days_remaining: daysRemaining,
        subscription_expires_at: meta.subscription_expires_at || null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at
      };
    });

    res.json({
      stats: {
        totalUsers: users.length,
        activeSubscriptions: activeSubs,
        todayQueries: todayQueriesCount,
        allTimeQueries: allQuestions.length,
        mrr: totalMRR > 0 ? `$${totalMRR}.00` : '$29.00' // Default fallback minimum if early stage
      },
      users
    });
  } catch (err) {
    console.error('[Admin API] Error in /api/admin/overview:', err);
    res.status(500).json({ error: 'Failed to fetch admin overview', details: err.message });
  }
});

// Admin: Block / Unblock user (Full Auth ban for abuse)
app.post('/api/admin/users/:id/block', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { block } = req.body; // true = block, false = unblock

  // Prevent blocking self
  if (req.adminUser && req.adminUser.id === id && block) {
    return res.status(400).json({ error: 'You cannot block your own Super-Admin account! Test blocking on another user.' });
  }

  try {
    const { data: { user }, error: getErr } = await supabase.auth.admin.getUserById(id);
    if (getErr) throw getErr;

    const updatePayload = {
      ban_duration: block ? '876000h' : 'none',
      user_metadata: {
        ...(user?.user_metadata || {}),
        is_blocked: Boolean(block)
      }
    };

    const { data, error } = await supabase.auth.admin.updateUserById(id, updatePayload);
    if (error) throw error;

    console.log(`[Admin] User ${id} auth block status updated to: ${block}`);
    res.json({ 
      success: true, 
      message: block ? 'User account blocked successfully' : 'User account unblocked successfully',
      is_blocked: Boolean(block)
    });
  } catch (err) {
    console.error('[Admin API] Error updating block status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Pause / Resume Widget (Service suspension without banning login)
app.post('/api/admin/users/:id/pause', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { pause } = req.body; // true = pause, false = resume

  if (req.adminUser && req.adminUser.id === id && pause) {
    return res.status(400).json({ error: 'You cannot pause your own account widget!' });
  }

  try {
    const { data: { user }, error: getErr } = await supabase.auth.admin.getUserById(id);
    if (getErr) throw getErr;

    const { error } = await supabase.auth.admin.updateUserById(id, {
      user_metadata: {
        ...(user?.user_metadata || {}),
        widget_paused: Boolean(pause)
      }
    });
    if (error) throw error;

    console.log(`[Admin] User ${id} widget pause status: ${pause}`);
    res.json({ 
      success: true, 
      message: pause ? 'Store AI widget paused' : 'Store AI widget resumed',
      widget_paused: Boolean(pause)
    });
  } catch (err) {
    console.error('[Admin API] Error updating pause status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Delete user permanently (GDPR / Super-Admin cleanup)
app.delete('/api/admin/users/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;

  if (req.adminUser && req.adminUser.id === id) {
    return res.status(400).json({ error: 'You cannot delete your own Super-Admin account!' });
  }

  try {
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) throw error;

    console.log(`[Admin] User ${id} permanently deleted.`);
    res.json({ success: true, message: 'User permanently deleted' });
  } catch (err) {
    console.error('[Admin API] Error deleting user:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Add or remove subscription days
app.post('/api/admin/users/:id/subscription', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { days } = req.body; // e.g. -30, 30, 365

  try {
    const { data: { user }, error: getErr } = await supabase.auth.admin.getUserById(id);
    if (getErr) throw getErr;

    const currentExpiry = user.user_metadata?.subscription_expires_at
      ? new Date(user.user_metadata.subscription_expires_at)
      : new Date();
    
    const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
    baseDate.setDate(baseDate.getDate() + parseInt(days, 10));

    const { error: updateErr } = await supabase.auth.admin.updateUserById(id, {
      user_metadata: {
        ...user.user_metadata,
        subscription_expires_at: baseDate.toISOString()
      }
    });
    if (updateErr) throw updateErr;

    res.json({
      success: true,
      newExpiry: baseDate.toISOString(),
      message: `${days > 0 ? 'Added' : 'Removed'} ${Math.abs(days)} days for ${user.email}`
    });
  } catch (err) {
    console.error('[Admin API] Error updating subscription:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Edit user email, store domain, plan, limits, and subscription
app.post('/api/admin/users/:id/update', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { email, store_domain, plan, query_limit, days_to_add } = req.body;

  try {
    const { data: { user }, error: getErr } = await supabase.auth.admin.getUserById(id);
    if (getErr) throw getErr;

    const newMeta = { ...user.user_metadata };
    if (store_domain) newMeta.store_domain = store_domain.trim();
    if (plan) newMeta.plan = plan;
    if (query_limit !== undefined && query_limit !== null) {
      newMeta.query_limit = parseInt(query_limit, 10);
    }

    if (days_to_add) {
      const currentExpiry = newMeta.subscription_expires_at
        ? new Date(newMeta.subscription_expires_at)
        : new Date();
      const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
      baseDate.setDate(baseDate.getDate() + parseInt(days_to_add, 10));
      newMeta.subscription_expires_at = baseDate.toISOString();
    }

    const updatePayload = {
      user_metadata: newMeta
    };
    if (email) {
      updatePayload.email = email.trim();
    }

    const { data, error: updateErr } = await supabase.auth.admin.updateUserById(id, updatePayload);
    if (updateErr) throw updateErr;

    res.json({ success: true, message: 'User updated successfully', user: data.user });
  } catch (err) {
    console.error('[Admin API] Error editing user:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🔒 Allowed Admin Emails: ${ADMIN_EMAILS.join(', ')}`);
});
