export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const domain = (req.query.domain || req.query.store_domain || '').trim().toLowerCase();

  const defaultSettings = {
    widget_color: '#3B82F6',
    theme_preset: 'classic',
    friendly_tone: true,
    use_emojis: true,
    white_label: false,
    exit_intent: false,
    plan: 'Starter'
  };

  if (!domain || domain === 'unknown') {
    return res.status(200).json(defaultSettings);
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vzmpwstfddznsvypudhj.supabase.co';
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (SUPABASE_SERVICE_KEY) {
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
      });
      if (authRes.ok) {
        const authData = await authRes.json();
        const user = (authData.users || []).find(u => (u.user_metadata?.store_domain || '').trim().toLowerCase() === domain);
        if (user && user.user_metadata) {
          const meta = user.user_metadata;
          const plan = (meta.plan || 'Starter').toLowerCase();
          return res.status(200).json({
            widget_color: meta.widget_color || '#3B82F6',
            theme_preset: meta.theme_preset || 'classic',
            friendly_tone: meta.friendly_tone !== false,
            use_emojis: meta.use_emojis !== false,
            white_label: plan === 'business' ? Boolean(meta.white_label) : false,
            exit_intent: (plan === 'pro' || plan === 'business') ? Boolean(meta.exit_intent) : false,
            plan: meta.plan || 'Starter'
          });
        }
      }
    }
  } catch (err) {
    console.warn('[Vercel API] /api/config error:', err.message);
  }

  return res.status(200).json(defaultSettings);
}
