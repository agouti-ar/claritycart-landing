# Stage 4: read-only findings and rollout gates

## Published Vercel — confirmed via connected tools

- Project: `prj_4eyIZV4I145kufxi5zn4Gb9pWi0I`, claritycart-landing.
- Production deployment: `dpl_8KYbeyr89FDCbUwNbop7m1KkQwoQ`, READY, source `redeploy`.
- Alias: https://claritycart-landing.vercel.app
- Immutable deployment URL: https://claritycart-landing-n83tkjruu-agouti-ar.vercel.app
- Published Git metadata: main, `c550ce8ff9f67ba3a987a1f7a5ea3acf53a24ef7`.
- Local HEAD: `df61fb7`, 12 commits after that SHA, plus the preserved uncommitted work.
- `git ls-tree -r --name-only c550ce8 api` contains only `api/chat.js`. New account/session/verification/admin routes are not in that published commit. Their 404s are therefore expected for this older version, not evidence that the prepared local routes fail.
- Deployment file-tree API returned 404 without scope and 403 with the reported team scope. Vercel requested additional team authorization; its one-time access link was shown in chat. Direct inspection of the deployed build's file tree remains unverified. Do not assert that these tool errors are public-site route errors.
- No deployment, promotion, environment-variable change or commit occurred. No pending failed deployment of the current local code was found in the five most recent deployment records.

## Live Supabase — read-only SQL now confirmed directly

Project `vzmpwstfddznsvypudhj` is the main project. Connected SQL reads confirmed 20 questions, RLS enabled, the previously reported public SELECT/INSERT policies, metadata-based owner policy, zero user triggers, and no Stage 1/2 objects/private schema or RPC name collisions.

The existing questions/settings schemas contain no stable user/store foreign key. Question IDs 1–15 store `127.0.0.1`; IDs 16,17,18,19,23 store `my-super-shoes.com`. These labels are not evidence of authenticated ownership. Product text and editable account metadata cannot establish that ownership either. No customer question text was fetched, no owner mapping was inferred, and no live row was changed.

`legacy-question-mapping-review.csv` lists those exact 20 IDs with blank store/owner targets, UNRESOLVED decisions and an evidence field. A reviewer must explicitly identify each approved question → store → owner relation. Unsupported rows may remain unmapped and preserved; completing Stage 4 does not require inventing an owner for them. The existing `scripts/legacy-question-mapping.sql` accepts only explicit reviewed rows, defaults to validation mode, and blocks conflicting/stale bindings or mappings that would invalidate existing usage counters.

## Exact order after separate target/operation approval

1. Independently identify the execution target. There is currently no approved disposable Supabase environment. Do not create one or use the main project as a test DB automatically.
2. Obtain a recoverable backup and arrange a coordinated maintenance window: old published clients still use the old request/write flow. Applying only the migrations while leaving the old client/API active can break recording. Do not enable traffic between the migration steps.
3. Run `scripts/supabase-readonly-preflight.sql`. Confirm questions columns/identity/defaults, no conflicting new objects, no unexpected triggers/policies, and current row counts. Recheck before execution even though the present schema is compatible.
4. With writes stopped, run `scripts/supabase-history-fingerprint.sql` and retain its count and aggregate fingerprint. It returns no question content. This is a preservation check, not a substitute for a backup.
5. Apply `migrations/001_chat_request_idempotency.sql`.
6. Apply `supabase/migrations/20261027142546_server_entitlements_and_monthly_quota.sql`.
7. Apply `supabase/migrations/20261027152654_widget_security_and_store_binding.sql`.
8. Run the history fingerprint again and compare. The migration definitions do not DELETE/TRUNCATE existing questions, UPDATE their original fields, modify auth.users or overwrite store_settings. New columns, tables, constraints, grants/policies and request-processing functions are added/replaced. REVOKE intentionally changes access and must be coordinated with rollout. DELETE inside the new rate-limit function only expires newly introduced rate bucket rows when that function is later invoked; it is not a historical-question deletion.
9. Run `scripts/supabase-stage4-postflight.sql`: 11 checks must pass and five public RPC rows must all report invoker-wrapper/service-allowed/anon-denied/authenticated-denied. This is read-only catalog inspection. Then run the synthetic two-owner and concurrent-request integration scenarios; catalog checks alone do not prove behavior.
10. Provision independently verified owner/store records, monthly anchors and server-owned manual test entitlements. Review and transfer legitimate saved styling/preferences from the retained old settings/metadata only after ownership is verified; do not transfer paid privileges from editable metadata. None of these records/settings are automatically populated by the migrations.
11. Validate explicitly approved historical mappings, then separately approve their application. Complete this before the first usage-period initialization. Unknown rows stay stored and unmapped. If counters already exist, prepare reconciliation instead of bypassing the mapping guard.
12. Configure isolated runtime credentials and a server-only WIDGET_SESSION_SECRET of at least 32 random characters. Do not send keys through chat or put a user access token into a public storefront snippet.
13. Only with separate deployment permission create a protected Vercel preview from the reviewed working tree (including required untracked lib/API files). Target claritycart-landing/preview explicitly; do not promote or change production aliases. Never point write-capable preview tests at the main DB without separate permission. If no isolated DB exists, keep a hosted synthetic/write test blocked and retain local evidence.
14. Verify owner → DNS or authenticated preview → signed widget session → request → persisted question/usage → same-ID replay across instances. Test anonymous/foreign owner rejection, forged metadata, monthly boundary, quota=1 under genuinely independent DB connections, AI failure/timeout/blocked behavior, request body limits, CORS, Vercel IP headers and static-file exclusion.

Migration 001 is outside the CLI migration folder. Do not blindly use `supabase db push` as if it applied the complete sequence. These SQL files are one-time migrations, not a rerunnable repair script; compare applied state first.

## DNS and feature preservation

DNS TXT verification remains the existing security mechanism. Normal storefront session issuance requires the verified HTTPS domain, then signed short-lived store/origin/epoch sessions. Domain/owner changes revoke old sessions. DNS is not bot-proof and does not replace quota/rate enforcement.

Onboarding consequence: the merchant needs DNS access, must add `_claritycart-verification.<domain>` TXT with the server-owned challenge, and must wait for propagation/confirmation. An ordinary unverified embed is denied. Authenticated owner/developer preview is distinct; wiring a polished onboarding flow remains pending. No API-key/installation-token redesign was made.

Final diff review found no deleted tracked files. Existing admin overview/block/pause/delete/subscription/update routes remain; ADMIN_EMAILS values/defaults are retained; developer mock/promo/white-label controls and themes remain. Mock execution is gated by server-confirmed developer preview. The accepted 74/74 tests cover these critical controls to the extent documented, not every visual interaction or actual admin session. This follow-up changes only verification SQL, review artifacts, tests and documentation. It does not reformat/revert existing dirty application files, and no reset/checkout/revert/commit was used.

## Verification and closure

Accepted application baseline: full suite 74/74 PASS, build PASS. This follow-up: mapping/migration/postflight/fingerprint suite 10/10 PASS on PGlite. The complete suite was not rerun for these verification-only additions; no runtime application code changed.

Stage 4 is closed only after the approved hosted migration/postflight and isolated end-to-end/concurrency tests pass, reviewed stores/entitlements/settings are provisioned, every historical row is either explicitly assigned or intentionally retained unresolved, and a separately authorized preview proves actual Vercel routing/runtime parity. All live operations and deployment remain gated. Paddle remains out of scope until explicit confirmation.
