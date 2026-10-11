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

// Admin: Block / Unblock user
app.post('/api/admin/users/:id/block', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { block } = req.body; // true = block, false = unblock

  try {
    const updatePayload = {
      ban_duration: block ? '876000h' : 'none',
      user_metadata: {
        is_blocked: Boolean(block)
      }
    };

    const { data, error } = await supabase.auth.admin.updateUserById(id, updatePayload);
    if (error) throw error;

    console.log(`[Admin] User ${id} block status updated to: ${block}`);
    res.json({ 
      success: true, 
      message: block ? 'User blocked successfully' : 'User unblocked successfully',
      is_blocked: Boolean(block)
    });
  } catch (err) {
    console.error('[Admin API] Error updating block status:', err);
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
