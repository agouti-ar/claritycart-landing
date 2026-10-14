export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let domain = (req.query.domain || req.query.url || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const fallbackColors = [
    '#3B82F6', // Electric Blue
    '#10B981', // Emerald Green
    '#8B5CF6', // Purple Glow
    '#F59E0B', // Amber Gold
    '#EC4899', // Cyber Pink
    '#06B6D4', // Deep Cyan
    '#6366F1'  // Indigo
  ];

  const getHashColor = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const idx = Math.abs(hash) % fallbackColors.length;
    return fallbackColors[idx];
  };

  if (!domain || domain === 'mystore.com' || domain === 'unknown') {
    return res.status(200).json({ color: fallbackColors[0], source: 'default' });
  }

  // Fast fetch to analyze merchant store site
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    let siteUrl = `https://${domain}`;
    let resp;
    try {
      resp = await fetch(siteUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'ClarityCart-ColorDetector/1.0 (+https://claritycart-landing.vercel.app)' }
      });
    } catch (httpsErr) {
      // Try HTTP fallback
      siteUrl = `http://${domain}`;
      resp = await fetch(siteUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'ClarityCart-ColorDetector/1.0' }
      });
    }
    clearTimeout(timeoutId);

    if (resp && resp.ok) {
      const html = await resp.text();

      // 1. Check meta theme-color
      const themeColorMatch = html.match(/<meta[^>]*name=["'](?:theme-color|msapplication-TileColor)["'][^>]*content=["'](#[0-9a-fA-F]{3,6})["']/i) ||
                             html.match(/<meta[^>]*content=["'](#[0-9a-fA-F]{3,6})["'][^>]*name=["'](?:theme-color|msapplication-TileColor)["']/i);
      if (themeColorMatch && themeColorMatch[1]) {
        return res.status(200).json({ color: normalizeHex(themeColorMatch[1]), source: 'meta_theme_color' });
      }

      // 2. Check CSS brand variables
      const cssVarMatch = html.match(/--(?:primary|brand|accent|theme|color-primary)[^:]*:\s*(#[0-9a-fA-F]{3,6})/i);
      if (cssVarMatch && cssVarMatch[1]) {
        return res.status(200).json({ color: normalizeHex(cssVarMatch[1]), source: 'css_variable' });
      }

      // 3. Scan for prominent saturated hex colors
      const hexMatches = html.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) || [];
      const validColors = [];

      for (const hex of hexMatches) {
        const norm = normalizeHex(hex);
        if (isSaturatedBrandColor(norm)) {
          validColors.push(norm);
        }
      }

      if (validColors.length > 0) {
        const freqMap = {};
        let topColor = validColors[0];
        let maxCount = 0;
        validColors.forEach(c => {
          freqMap[c] = (freqMap[c] || 0) + 1;
          if (freqMap[c] > maxCount) {
            maxCount = freqMap[c];
            topColor = c;
          }
        });
        return res.status(200).json({ color: topColor, source: 'page_palette' });
      }
    }
  } catch (err) {
    // Fail silently to smart domain-based palette
  }

  // Smart domain-based harmonious fallback
  return res.status(200).json({ color: getHashColor(domain), source: 'smart_fallback' });
}

function normalizeHex(hex) {
  let clean = hex.trim().toUpperCase();
  if (clean.length === 4) {
    clean = '#' + clean[1] + clean[1] + clean[2] + clean[2] + clean[3] + clean[3];
  }
  return clean;
}

function isSaturatedBrandColor(hex) {
  if (!hex || hex.length !== 7) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (delta < 30) return false;
  if (max < 40) return false;
  if (min > 230) return false;

  return true;
}
