# Stage 10 — themes and safe color detection

## Theme contract

`widget-themes.js` is the shared browser/CommonJS registry. Four presets use one stylesheet and 15 CSS tokens: background, surface, foreground, muted text, accent, readable accent foreground, readable accent text, border, radii, chip palette, shadows and focus ring. `neon_pop` remains accepted and renders `solar_graphite`; existing settings are not rewritten. No merchant add-to-cart button is decorated by the theme.

`widget_color` accepts a six-digit hex override or `null` to restore the preset's native accent. Missing public color is now `null`, rather than forcing blue over every preset. Classic still defaults to `#3B82F6`. Only paid active Pro/Business public config enables non-classic themes; a visual preview grants no server privileges. Black/white accent foreground is selected by contrast. Existing settings CAS prevents lost successful updates.

Dashboard uses `theme-preview.js`, the same registry and shadow CSS as the widget. Color dragging previews locally; persistence/broadcast happens after account API acknowledgement. Reset restores native accent. `test.html` provides independent visual controls and a sample preview without changing AI authorization. Both new modules are explicitly included in the public build.

## Detect-color contract

`api/detect-color.js` exports CommonJS; local Express and Vercel use `createDetectColorHandler` from `lib/detect-color.js`. GET requires a Supabase owner Bearer token and owned store ID/domain. Active Pro/Business or existing server-admin allowlist is required; admins still need ownership. Existing persistent rate RPC limits each owner to 10 attempts/minute. No new secret: it uses the existing `WIDGET_SESSION_SECRET`, Supabase URL/service key and `ADMIN_EMAILS`.

`lib/safe-site-fetch.js` validates URL and every redirect/resource; rejects userinfo, nonstandard ports, non-HTTP(S), localhost and internal names, private/reserved IPv4 and non-global/special IPv6. All DNS answers must be public. The selected address is pinned into native HTTP(S) lookup (no second DNS lookup), with TLS hostname verification retained and connected peer checked. HTTPS downgrade redirects are rejected. No cookies, supplied headers, proxy credentials or browser script execution.

Limits: 6 seconds total including DNS; 3 redirects per resource; 8 requests total; 16 KB headers; 180 KB HTML, 16 KB manifest, 64 KB per stylesheet (at most two), 32 KB SVG; 300 KB total. Compressed responses are rejected to avoid decompression bombs. MIME types are checked. Images/scripts/CSS imports and SVG external references are not executed or followed.

Detection considers explicit meta theme color, root/body/html brand CSS variables (bounded alias resolution), manifest theme_color, linked CSS, or one unambiguous saturated SVG icon fill. Source identifies the evidence; it is a hint, not a guarantee of brand identity. No domain hash or color-frequency guess is reported as detected. Missing hints return `{detected:false,source:'fallback',color:'#3B82F6'}`; unavailable sites add `reason:'site_unavailable'`. Unsafe destinations return 400; auth/plan/rate failures retain their status and are not saved as fallback by the UI.

## Local verification and deployment limits

`tests/themes.test.js`: registry, contrast, legacy alias, injection rejection, shared preview, reset and public config gating.
`tests/detect-color.test.js`: URL/IP encodings, mixed DNS, rebinding/redirects, pinned lookup/peer, size/type/encoding/time limits, explicit sources and honest fallback.
`tests/themes-db.test.js`: PGlite settings roundtrip and real local HTTP through the shared handler; ownership, plan, expiry, methods and persistent rate limit. Outbound website transport is synthetic; no production data is accessed.

No new migrations or environment variables. Real website detection on Vercel, deployed dashboard browser appearance, CSP compatibility and live Supabase integration remain deployment checks. Production, DNS and billing configuration are unchanged.
