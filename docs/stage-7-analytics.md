# Stage 7 — recorded storefront activity

## Sources and definitions

- `clarity.js` emits `session_start`, `product_view` (Product JSON-LD/microdata or the configured add-to-cart target), and confirmed `cart_add`. It never emits a billable answer/usage event.
- A visitor is a random browser ID stored on the merchant origin, expiring after 90 days. It is not a person/account and resets when storage is cleared. Sessions are per tab, survive refresh/navigation, and rotate after 30 minutes without tracked interaction. Browser storage unavailable means tracking is skipped; no fingerprinting fallback is used.
- `POST /api/events` requires the existing signed widget session, matching origin, current store epoch and verified storefront domain. Owner/admin preview sessions are acknowledged but not inserted. Local/mock tracking is disabled. The store binding is locked and rechecked inside SQL. Origin headers and browser telemetry do not prove a human or a financial transaction; clients with valid public storefront sessions can fabricate telemetry, subject to persisted limits.
- Payload: <=16 KiB, <=20 events, UUID event/visitor/session IDs, allowlisted fields/types/cart sources. No prices, revenue, email, question text, arbitrary properties, query strings or URL fragments are accepted. Product pathname and visitor ID are HMAC-hashed with a store-specific prefix before storage; raw values are not written to analytics tables. Session/event UUIDs remain pseudonymous identifiers. IP is used only by existing hashed rate buckets.
- Client queue is capped at 100 events / five minutes, retained across refresh in sessionStorage. Retries preserve event IDs. Server PK `(store_id,event_id)` and one session-start per session prevent duplicate counts. Changed replay payloads reject the whole batch; replay does not extend session last_seen.
- Limits: persisted 60 POSTs/minute/IP and 300/minute/store. Analytics uses separate rate buckets from AI; does not spend or bypass AI quota. Batch limits bound accepted rows. No CAPTCHA/bot-proof unique-person claims are made.

## AI and metric authority

The existing request completion transaction remains the only writer of usage/questions. A separate optional RPC attaches telemetry context to the already-claimed request and records storefront/preview provenance before generation. It has a 1.2-second client deadline; failure/missing analytics migration does not stop AI or create another usage event. Preview, AI errors, blocked requests and replays do not inflate recorded storefront answers. Missing attribution remains explicitly unclassified.

The owner-only `GET /api/events?store_id=UUID` aggregates a rolling 30 days (server timestamps); chart buckets use the last seven UTC completion days:

| Metric | Source |
| --- | --- |
| Questions Answered | Completed, usage-confirmed chat requests with recorded storefront provenance. Old/unknown provenance is reported separately, not guessed. |
| Sessions / unique browser visitors | Recorded sessions / distinct visitor hashes active within the window. Includes sessions created by a genuine chat interaction even if its AI answer subsequently fails. |
| Product views / cart additions | Accepted respective events. Adds are operations, not quantity, orders or attributed conversions. |
| Engaged visitors | Distinct known visitor hashes with a committed successful storefront answer. No visitor ID means no engagement attribution. |
| Estimated Time Saved | Confirmed answers × 150 seconds, explicitly labeled estimate. It is **not measured support labor saved**; merchant-calibrated baseline is future work. |
| Revenue / conversion uplift | Unconnected (`null` / “Not connected”). No questions×price or keyword cart estimates. Orders and a control/baseline methodology are still required. |

Core metrics are available to authenticated store owners. Cart/engagement aggregates are returned only for an authoritative active Business entitlement or configured ADMIN_EMAILS identity. Events may be collected before upgrade, but frontend flags cannot unlock paid aggregates. Existing super-admin/mock tools remain intact. Sentiment UI is preserved with an explicit keyword-estimate label; it is not a measured satisfaction score.

Dashboard monthly quota counters still use `/api/account`; the separate analytics cards use 30-day aggregates. Missing migration/API returns “— / Analytics unavailable” rather than fake zeros, without breaking quota/access controls.

## Cart and consent integration

Shopify: successful same-origin POST fetch to `/cart/add`, `/cart/add.js` or `/cart/add.json` is observed only when its cloned JSON confirms item IDs and positive quantities (redirects/errors are excluded); original response/errors are preserved. XHR-only themes need the merchant bridge. WooCommerce: existing jQuery `added_to_cart` event is observed when Woo globals are already loaded. No button-click guessing is used.

Other platforms, delayed adapters or SPA pages can integrate explicitly after their cart mutation succeeds:

```js
document.dispatchEvent(new CustomEvent('claritycart:cart-added', {
  detail: { confirmed: true, event_id: crypto.randomUUID() }
}));
```

Emit once per successful operation. Preserve the event_id on application retries. Do not additionally emit the bridge for an operation already observed by the Shopify/Woo adapter (otherwise they are separate events).

Tracking respects `navigator.globalPrivacyControl`, `navigator.doNotTrack === '1'`, `<script data-analytics="off">` and `ClarityCartConfig.analyticsConsent === false`. If consent is required by the merchant's setup, set it **before loading** clarity.js; grant/revoke via:

```js
document.dispatchEvent(new CustomEvent('claritycart:analytics-consent', {
  detail: { granted: true } // false clears unsent events and stops further identity collection
}));
```

Withdrawal stops future collection; it does not delete already collected aggregates. Server retention/erasure scheduling and Privacy Policy alignment remain Stage 11 work. The browser's 90-day ID expiry is not automatic DB retention. This code does not assert legal compliance.

## Local / Vercel routing

Local Express handles `/api/events`. Vercel rewrites that path to the **existing** shared `/api/billing/events` catchall function, which uses the same handler before billing routes. This avoids adding a thirteenth serverless function. The alias is not a paid billing bypass: the handler performs the same token/ownership checks. The actual deployed rewrite/CORS behavior still needs an authorized Preview rollout and smoke test.

## Prepared rollout — NOT executed

1. Review `supabase/migrations/20261101085947_storefront_analytics.sql`. Requires Stage 1–4. It is independent of the unapplied Paddle migration; **do not run a blanket db push that would also apply Paddle**.
2. Existing questions/request content/IDs/ownership are unchanged. Three nullable analytics columns are added to chat_requests; old provenance stays unknown. Two RLS-protected private tables and three service-only invoker RPC wrappers are created. No data deletion/backfill/assignment is performed. Migration is one transaction; rerun stops on existing objects rather than rewriting them.
3. On separate approval, manually apply only this Stage 7 SQL, then run `scripts/analytics-readonly-postflight.sql`; both tables must have RLS, zero anon/auth direct access, and all three wrappers service-only. Original history fingerprint must remain unchanged.
4. On separate approval, deploy Preview, verify `/api/events` OPTIONS/POST/owner GET, and test a verified synthetic storefront (preview sessions are deliberately excluded). Confirm event replay, cart success/failure, actual Gemini answer and single authoritative usage. Existing DNS verification is unchanged.

No live SQL, commit, push, deployment or external configuration change is authorized/performed by this implementation. The accepted uncommitted onboarding redesign is preserved.

## Verification evidence

- Full local regression: **137/137 PASS**, no failures/skips (`node --test --test-concurrency=1 tests/*.test.js`).
- Stage 7 DB/API: **14 PGlite tests** in that run cover migration/history preservation, RLS/grants, event/session deduplication/concurrency, payload conflicts, origin/store/epoch binding, spam limits, preview exclusion, successful AI usage/replay/errors, optional-analytics failure, 30-day windows, Business entitlement and read-only postflight.
- After the final Shopify JSON-confirmation guard: client suite **6/6 PASS**, including failed/false-success cart responses, consent/privacy exclusions, session rollover, retry/refresh and UI rendering.
- Build **PASS** (20 explicitly allowed assets); inline dashboard/insights JS syntax and `git diff --check` **PASS**.
- Actual Google/Gemini/Shopify/WooCommerce services, live Supabase schema/application and published Vercel rewrite/CORS have **not** been tested for Stage 7. The HTTP API checks ran against Local Express/PGlite, including the same alias used by the Vercel entry.
