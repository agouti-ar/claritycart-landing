require('dotenv').config({quiet:true});
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

function createApp(options = {}) {
const app = express();

// Enable CORS for frontend requests
app.use(cors({
  origin: '*' // In production, this can be restricted to your domain
}));

// Paddle signatures require the exact bytes, before any JSON middleware.
const billing=require('./lib/billing-handler').createBillingHandlers({db:options.db,...(options.billingOptions||{})});
app.post('/api/billing/webhook',express.raw({type:'application/json',limit:'256kb'}),billing.webhook);
// Parse JSON request bodies
app.use(express.json({limit:'32kb'}));
app.all('/api/billing/:action',billing.api);

// Serve static files from workspace root (dashboard.html, test.html, clarity.js, etc.)
app.use((req,res,next)=>{
  let target;
  try {target=require('node:path').posix.normalize(decodeURIComponent(req.path).replaceAll('\\','/'));}catch{return res.status(400).json({error:'INVALID_PATH'});}
  if(/^\/(?:lib|scripts|tests|docs|migrations|supabase|node_modules)(?:\/|$)|^\/(?:server|backend)\.js$|^\/package(?:-lock)?\.json$/.test(target))return res.status(404).json({error:'NOT_FOUND'});
  req.ccPath=target;next();
});
const servePublic=express.static(__dirname);
app.use((req,res,next)=>req.ccPath.startsWith('/api/')?next():servePublic(req,res,next));

// Initialize Supabase with the SERVICE_ROLE key to bypass RLS restrictions securely on the server
const supabase = options.db || createClient(
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

    if(req.params.id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id))return res.status(400).json({error:'INVALID_USER_ID'});
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

// Preview sync retains its endpoint, but writes require the store owner or super-admin.
const previewSettings = new Map();
app.get('/api/live-sync',async(req,res)=>{
 try {const domain=String(req.query.domain||req.query.store_domain||'').toLowerCase();const {data,error}=await supabase.from('cc_stores').select('*').eq('domain',domain).maybeSingle();
  if(error)throw error;if(!data)return res.status(404).json({error:'UNKNOWN_STORE'});
  return res.json(previewSettings.get(data.id)||require('./api/config').publicSettings(await snapshot(supabase,data.id)));
 }catch{return res.status(503).json({error:'SYNC_UNAVAILABLE'});}
});
app.post('/api/live-sync',async(req,res)=>{
 try {const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];if(!token)return res.status(401).json({error:'AUTH_REQUIRED'});
  const {data:auth,error:authError}=await supabase.auth.getUser(token);if(authError||!auth?.user)return res.status(401).json({error:'INVALID_SESSION'});
  const {data:store,error}=await supabase.from('cc_stores').select('*').eq('domain',String(req.body.domain||'').toLowerCase()).maybeSingle();if(error)throw error;
  if(!store||store.owner_id!==auth.user.id&&!ADMIN_EMAILS.includes(String(auth.user.email||'').toLowerCase()))return res.status(403).json({error:'STORE_OWNER_MISMATCH'});
  const {domain,store_domain,...settings}=req.body;
  const patch=require('./lib/store-access').validatedPatch({settings},store);
  const safe=require('./api/config').publicSettings({...await snapshot(supabase,store.id),settings:patch.settings});previewSettings.set(store.id,safe);
  return res.json({success:true,settings:safe});
 }catch{return res.status(400).json({error:'INVALID_SYNC_UPDATE'});}
});

// Account/config use protected store data in both local and Vercel routes.
const { updateOwnedStore, storeForOwner, snapshot } = require('./lib/store-access');
app.get('/api/config', require('./api/config').createConfigHandler({db:supabase}));
app.all('/api/account', require('./lib/store-access').createAccountHandler({db:supabase}));
app.all('/api/verify-domain', require('./lib/domain-verification').createDomainVerificationHandler({db:supabase}));

// The same authoritative usage path serves local and Vercel requests.
const chatHandler = require('./lib/usage-handler').createUsageHandler(options.generateAI || require('./api/chat').generateResponse, {db:supabase, ...(options.authorizeWidget ? {authorize:options.authorizeWidget} : {})});
const { createLocalChatHandler } = require('./lib/local-chat');
app.post('/api/chat', createLocalChatHandler(chatHandler,{hasApiKey:options.hasApiKey}));
app.all('/api/widget-session',createLocalChatHandler(require('./lib/request-security').createWidgetSessionHandler({db:supabase}),{endpoint:'widget-session',hasApiKey:options.hasApiKey}));

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

    const {data: registry,error: registryError}=await supabase.from('cc_stores').select('id,owner_id');
    if(registryError)throw registryError;
    const protectedStores=await Promise.all((registry||[]).map(s=>snapshot(supabase,s.id)));
    const users = authData.users.map(u => {
      const protectedStore=protectedStores.find(s=>s.owner_id===u.id);
      const meta = u.user_metadata || {};
      const storeDomain = protectedStore?.domain || 'not-connected.com';
      const plan = protectedStore?.plan || 'Unprovisioned';
      const queryLimit=protectedStore?.query_limit ?? 0;
      const planPrice=plan==='pro'?29.99:plan==='business'?79.99:plan==='starter'?9.99:0;
      const queryCount=protectedStore?.query_count ?? 0;
      const isBlocked = Boolean(u.banned_until && new Date(u.banned_until) > new Date()) || protectedStore?.status==='paused';
      
      if (!isBlocked && protectedStore?.access_active) {
        activeSubs++;
        totalMRR += planPrice;
      }

      // Calculate days remaining in subscription
      let daysRemaining = 0; // default
      if (protectedStore?.access_until) {
        const diffMs = new Date(protectedStore?.access_until) - new Date();
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
        widget_paused: protectedStore?.status==='paused',
        days_remaining: daysRemaining,
        subscription_expires_at: protectedStore?.access_until || null,
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

    if(await storeForOwner(supabase,id)) await updateOwnedStore(supabase,id,{pause:Boolean(block)},true);
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

    await updateOwnedStore(supabase,id,{pause:Boolean(pause)},true);
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

    const updatedStore=await updateOwnedStore(supabase,id,{days_to_add:days},true);
    const baseDate=new Date(updatedStore.access_until);
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

    const authoritativePatch = {};
    if(store_domain!==undefined) authoritativePatch.store_domain=store_domain;
    if(plan!==undefined) authoritativePatch.plan=plan;
    if(query_limit!==undefined) authoritativePatch.query_limit=query_limit;
    if(days_to_add!==undefined && days_to_add!==0) authoritativePatch.days_to_add=days_to_add;
    if(Object.keys(authoritativePatch).length) await updateOwnedStore(supabase,id,authoritativePatch,true);
    const newMeta = { ...user.user_metadata }; // Compatibility mirror; never authoritative.
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

    res.json({ success: true, user: data.user });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Cancellation Feedback Webhook & Notification Endpoint
app.post('/api/webhook/cancellation', async (req, res) => {
  const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
  if(!token)return res.status(401).json({error:'AUTH_REQUIRED'});
  const {data:auth,error:authError}=await supabase.auth.getUser(token);
  if(authError||!auth?.user)return res.status(401).json({error:'INVALID_SESSION'});
  const store=await storeForOwner(supabase,auth.user.id);
  if(!store||store.domain!==req.body.store_domain)return res.status(403).json({error:'STORE_OWNER_MISMATCH'});
  const {reason,feedback,canceled_at}=req.body;
  if(typeof reason!=='string'||reason.length>200||typeof feedback!=='string'||feedback.length>2000)return res.status(400).json({error:'INVALID_FEEDBACK'});
  const user_email=auth.user.email,store_domain=store.domain,plan=store.plan;
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚨 [CANCELLATION ALERT] A customer requested cancellation:');
  console.log(`   👤 User Email:   ${user_email || 'Unknown'}`);
  console.log(`   🌐 Store Domain: ${store_domain || 'Unknown'}`);
  console.log(`   🏷️ Current Plan:  ${plan || 'Unknown'}`);
  console.log(`   ❓ Reason:        ${reason || 'Not provided'}`);
  console.log(`   💬 Custom Notes:  ${feedback || 'None'}`);
  console.log(`   ⏰ Timestamp:     ${canceled_at || new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // If TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are provided in .env, send instantaneous alert!
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChatId) {
    try {
      const msg = `🚨 *ClarityCart Subscription Canceled*\n\n` +
        `👤 *User:* \`${user_email}\`\n` +
        `🌐 *Store:* \`${store_domain}\`\n` +
        `🏷️ *Plan:* *${plan}*\n` +
        `❓ *Reason:* ${reason}\n` +
        `💬 *Feedback:* _${feedback || 'None'}_\n` +
        `⏰ *Time:* ${new Date().toLocaleString()}`;
      
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChatId,
          text: msg,
          parse_mode: 'Markdown'
        })
      });
      console.log('[Backend] Dispatched Telegram alert successfully!');
    } catch (tgErr) {
      console.warn('[Backend] Could not send Telegram alert:', tgErr.message);
    }
  }

  res.json({ success: true, message: 'Cancellation feedback logged successfully' });
});



// Auto-detect dominant brand color from a store website
app.get('/api/detect-color', async (req, res) => {
  let domain = (req.query.domain || req.query.url || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const fallbackColors = ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EC4899', '#06B6D4', '#6366F1'];
  const getHashColor = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return fallbackColors[Math.abs(hash) % fallbackColors.length];
  };

  // 1. If local demo store or localhost, check test.html directly for demo testability!
  if (domain === 'my-super-shoes.com' || domain === '127.0.0.1' || domain === 'localhost') {
    try {
      const fs = require('fs');
      const path = require('path');
      const testHtmlPath = path.join(__dirname, 'test.html');
      if (fs.existsSync(testHtmlPath)) {
        const testHtml = fs.readFileSync(testHtmlPath, 'utf8');
        const themeMatch = testHtml.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["'](#[0-9a-fA-F]{3,6})["']/i);
        if (themeMatch && themeMatch[1]) {
          let c = themeMatch[1].trim().toUpperCase();
          if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
          return res.json({ color: c, source: 'test_page_meta_theme_color' });
        }
      }
    } catch(e) {}
    // If no explicit meta tag in test.html, return Emerald as demo brand color
    return res.json({ color: '#10B981', source: 'store_brand_palette' });
  }

  if (!domain || domain === 'mystore.com' || domain === 'unknown') {
    return res.json({ color: '#3B82F6', source: 'default' });
  }

  // 2. Fetch live store website
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    let siteUrl = `https://${domain}`;
    let resp;
    try {
      resp = await fetch(siteUrl, { signal: controller.signal, headers: { 'User-Agent': 'ClarityCart-ColorDetector/1.0' } });
    } catch (e) {
      siteUrl = `http://${domain}`;
      resp = await fetch(siteUrl, { signal: controller.signal, headers: { 'User-Agent': 'ClarityCart-ColorDetector/1.0' } });
    }
    clearTimeout(timeoutId);

    if (resp && resp.ok) {
      const html = await resp.text();
      const themeColorMatch = html.match(/<meta[^>]*name=["'](?:theme-color|msapplication-TileColor)["'][^>]*content=["'](#[0-9a-fA-F]{3,6})["']/i) ||
                             html.match(/<meta[^>]*content=["'](#[0-9a-fA-F]{3,6})["'][^>]*name=["'](?:theme-color|msapplication-TileColor)["']/i);
      if (themeColorMatch && themeColorMatch[1]) {
        let c = themeColorMatch[1].trim().toUpperCase();
        if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
        return res.json({ color: c, source: 'meta_theme_color' });
      }

      const cssVarMatch = html.match(/--(?:primary|brand|accent|theme|button)[^:]*:\s*(#[0-9a-fA-F]{3,6})/i);
      if (cssVarMatch && cssVarMatch[1]) {
        let c = cssVarMatch[1].trim().toUpperCase();
        if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
        return res.json({ color: c, source: 'css_variable' });
      }
    }
  } catch (err) {
    // Fail silently to smart fallback
  }

  return res.json({ color: getHashColor(domain), source: 'smart_fallback' });
});

app.use((error,req,res,next)=>{
 if(error?.type==='entity.too.large')return res.status(413).json({error:'INPUT_TOO_LARGE'});
 if(error instanceof SyntaxError)return res.status(400).json({error:'INVALID_JSON'});
 console.warn('[API] Request failed:',error.code||error.name);return res.status(500).json({error:'REQUEST_FAILED'});
});
return app;
}
let defaultApp;
function handler(req,res){defaultApp ||= createApp();return defaultApp(req,res);}
module.exports=handler;
module.exports.createApp=createApp;
if(require.main===module){
 const PORT=process.env.PORT||3000;createApp().listen(PORT,'0.0.0.0',()=>console.log('ClarityCart API listening on port '+PORT));
}
