# Stage 6 — Google OAuth and owned stores

## Flow implemented locally

- Google buttons on login/register use Supabase PKCE and redirect to the **same origin** `/auth-callback.html`. The callback lets the SDK exchange the code once, verifies the user through Auth, removes callback query/hash values and routes only to `onboarding.html`. No arbitrary `next` redirect is supported. Failed/denied callbacks stay on a retry page; provider error descriptions and tokens are not echoed.
- Email signup uses the same confirmation destination. With no session it asks the user to confirm their email instead of assuming authentication succeeded. Store domain entered at signup is only an editable browser draft; it does not assign ownership or rights in Auth metadata.
- Onboarding lists owned stores and allows explicit selection or creation. An owner-scoped sessionStorage selection is used by dashboard and insights. Missing/deleted/foreign selected stores send the user back to onboarding, without claiming a store by domain. A Stores link permits switching. The server remains authoritative if browser storage is edited.
- Existing users/stores keep their IDs, settings and entitlements. No existing Auth identities are merged or reassigned by this code. Google identity linking follows Supabase Auth configuration; matching email is never a server-side store lookup.

## Server boundary

The existing `/api/account` entry is shared by Local and Vercel; no new function is added.

| Request | Behavior |
| --- | --- |
| `GET ?list=1` | Returns at most 100 stores owned by verified JWT user; ID/domain/status only. |
| `POST {"store_domain":"shop.example.com"}` | Requires authenticated confirmed user; hostname validated; persisted 10 attempts/minute per identity. Server supplies owner, Starter and inactive status. |
| Repeat POST | The existing unique domain constraint serializes competing inserts. Same owner gets the same ID; a different owner gets generic DOMAIN_UNAVAILABLE. No upsert/reassignment. |
| Existing GET/PATCH `?store_id=UUID` | Ownership enforced; malformed ID rejected; paid fields still rejected. |

Creation does **not** start a trial, reset usage, activate access, grant Pro/Business, mark a domain verified, or bind legacy questions. Existing database defaults expire access immediately. Domain verification is unchanged: the merchant must still prove DNS ownership before public storefront sessions. This creates an onboarding step; it is intentionally not replaced by a token or meta tag here.

An unverified domain reservation is not proof of domain ownership. A conflict requires support and DNS evidence; this code does not automatically transfer another account's store or history.

No new SQL migration is required for Stage 6. It uses the Stage 1–4 schema, domain uniqueness and persisted rate RPC already rolled out. Stage 5 billing migration remains a separate unapplied prerequisite for checkout; its absence must not block creating an inactive store.

## Manual external setup (not performed)

1. In Google Cloud / Google Auth Platform, configure a web OAuth client and consent screen. During Testing, add intended test accounts to the audience. Use basic identity scopes (`openid`, email, profile); do not request offline Google API access for login alone.
2. Google authorized JavaScript origins must include each actual app origin used to initiate login. Authorized redirect URI is **`https://vzmpwstfddznsvypudhj.supabase.co/auth/v1/callback`**, not the app callback page.
3. In Supabase **Authentication → Sign In / Providers → Google**, enable the provider and enter the Google client ID and secret. Keep the secret there; do not put it in frontend code or send it in chat.
4. In Supabase **Authentication → URL Configuration**, use the real production origin as Site URL. Add exact app callback URLs to Redirect URLs:
   - `http://127.0.0.1:3000/auth-callback.html`
   - `http://localhost:3000/auth-callback.html`
   - if using Live Server, the exact origin/port such as `http://127.0.0.1:5500/auth-callback.html`
   - `https://<actual-preview-deployment>.vercel.app/auth-callback.html`
   - `https://<actual-production-host>/auth-callback.html`
   Keep existing password-recovery URLs. Avoid allowing unrelated previews or broad production wildcards.
5. PKCE initiation and completion must use the **same browser and origin**, where the verifier is stored. If email confirmation opens a different browser/device, retry from the original browser. If custom email templates ignore RedirectTo, update them using Supabase's documented confirmation template; do not redirect all auth callbacks to the dashboard.
6. Vercel protection must allow the testing user to visit the Preview callback. No deployment/protection setting has been changed. No new server secret is required: existing SUPABASE_URL and SUPABASE_SERVICE_KEY remain server-side; the existing browser anon key is public. Google client secret belongs only to the provider configuration.

Official references: [Google provider](https://supabase.com/docs/guides/auth/social-sign-in/auth-google), [PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls).

## Real integration checklist still pending

- New Google user → callback → no stores → explicit create → inactive store owned by that exact user.
- Existing Google/email account → callback → existing store selection; no duplicate store or reset entitlements/history. Check actual provider identity-linking behavior with the project's settings.
- Deny consent; expired/reused code; missing verifier; provider unavailable; email confirmation required; refresh and return from another tab.
- Select a second owned store, then verify dashboard/insights/widget preview use its ID. Edit browser store ID to a foreign/deleted ID and confirm rejection/re-onboarding.
- Verify real DNS challenge still gates public storefront sessions. No paid AI entitlement is expected from Google login or store creation alone.

Local PGlite/mocked Auth/DOM tests do not establish real Google login, email delivery, Supabase provider configuration or hosted Vercel callback behavior. Stage 6 changes are committed locally on explicit user approval (2026-10-29); production data/configuration has not been changed.

## Local verification

- Full regression: `node --test --test-concurrency=1 tests/*.test.js` — **117/117 PASS**, no skips/failures (includes 10 Stage 6 tests).
- Confirmed identity creation, inactive Starter defaults, duplicate/concurrent POST, foreign ownership rejection, confirmed-email requirement, metadata/paid-field rejection, owner-only listing and persisted rate limit: PGlite + mocked Auth.
- Callback success/denial/expired session, URL cleanup, fixed redirect, DOM injection safety and owner-scoped selection: mocked Auth/DOM. Browser helper → actual Local HTTP handler → PGlite store creation: PASS.
- Build: **PASS**, 19 allowlisted public assets; inline script syntax checks for all six affected HTML pages: **PASS**; `git diff --check`: **PASS**. Changed files were scanned against local secret values; no matches.
- Real browser rendering, real Google consent/identity linking, Supabase email delivery and a deployed Vercel callback: **not tested**.
