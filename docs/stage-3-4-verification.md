# Stage 3–4 verification — 2026-10-27

Later connected-tool findings, exact rollout order, postflight scripts and DNS/onboarding notes are in `stage-4-rollout-handoff.md`. Supabase/Vercel connector tools became available after the checks below; their earlier absence is historical, not the current access state.

Paddle work is paused pending the user's confirmation. No commit, deploy, production migration, data mapping or RLS change was performed.

## Changes in this follow-up

- `scripts/legacy-question-mapping.sql`: explicit question ID → store ID plan with expected owner ID and separate expected current/historical domains. Default mode validates only. No domain lookup assigns ownership. Existing bindings to another store, missing IDs, stale owner/domain and non-legacy questions are rejected atomically. New mappings after a store has any usage period are rejected to avoid silently diverging counters. Same-store repeat mapping is harmless. Only `cc_store_id` can be updated; historical content, IDs and timestamps are preserved.
- `tests/legacy-mapping.test.js`: history is seeded before the migration chain, then checked after all three migrations. Dry run, atomic rejection, renamed domains, unmapped rows sharing a domain, owner RLS, forged metadata, monthly counts and late mapping are tested.
- `tests/helpers/test-db.js`: optional pre-migration fixture hook only; existing application behavior unchanged.
- `scripts/verify-published-readonly.js`: reproducible credential-free GET-only probe. Results in `published-readonly-check.json`; no AI calls, sessions or writes.

## Local verification

The first full sequential run of the existing six test files passed **67/67**, including the deterministic rate-limit test. The new mapping suite separately passed **7/7** (six subtests plus parent).

Final combined command `node --test --test-concurrency=1 tests/*.test.js` passed **74/74**, with zero failures, cancellations or skips (172.8 seconds). This includes all seven test files after the mapping additions and the fixed rate clock. `npm run build` also passed, emitting the 14 explicitly allowed public assets.

Test database is PGlite, not a live hosted Supabase branch. HTTP parity tests run two local apps using the shared Local/Vercel handler. They do not emulate the Vercel routing/CDN/runtime or multiple independent PostgreSQL connections. `git diff --check` still reports five trailing-whitespace lines in pre-existing dirty changes in clarity.js/dashboard.html; they were not reformatted in this scoped follow-up.

## Real Supabase: read only

The existing server-key read-only inspector connected to project `vzmpwstfddznsvypudhj`. REST schema lists `questions` and `store_settings`; no new RPCs were present; exact question count was **20**. No question text or credentials were printed. SQL Editor preflight previously supplied by the user remains the evidence for actual policies, grants, identity/defaults and triggers; REST schema alone cannot verify these.

The user explicitly confirmed that `vzmpwstfddznsvypudhj` is the main project and that no separate test project/branch exists. Do not create a project or apply migrations, change policies or map data there without separate confirmation. No test database URL or CLI management authentication is configured locally, and no Supabase/Vercel runtime connector tools are exposed in this session. Applying the migrations and testing RLS on hosted Supabase remains an **UNFINISHED STAGE 4 STEP**, not a prerequisite for continuing independent local checks.

## Real Vercel: unauthenticated GET only

At the timestamp in `published-readonly-check.json`, landing and widget assets returned 200 and their SHA-256 hashes differed from the working tree. `/api/health`, `/api/account`, `/api/admin/overview`, `/api/widget-session`, `/api/verify-domain` and `/api/live-sync` returned 404. `/server.js` and `/lib/request-security.js` also returned 404.

These observations are consistent with an older deployment and do not establish a new defect in the prepared local handlers. They also do not establish parity. No authenticated actions, AI generation, hosted quota races, forwarded-IP behavior or webhook delivery was tested. No deployment was created or changed.

## Prepared migration order — not approval to apply

1. `migrations/001_chat_request_idempotency.sql`
2. `supabase/migrations/20261027142546_server_entitlements_and_monthly_quota.sql`
3. `supabase/migrations/20261027152654_widget_security_and_store_binding.sql`

All three execute against the local fixture matching the reported `questions` schema and preserve pre-existing synthetic history. This is local compatibility evidence, not hosted Supabase certification. Migration 001 is outside the Supabase CLI migration folder: do not run a blind `db push` and assume all three were applied. Follow the explicit order in a disposable test project and record which SQL was applied.

Before enabling traffic, provision verified owner/store records and independently review an explicit ID mapping. Fill the mapping template and run its default validation mode first. Switching it to apply mode is a separate reviewed data operation; it has not been done. Historical production questions remain unchanged and unmapped. Do not infer paid access or question ownership from editable metadata/domain matches. If usage periods already exist, stop and prepare a separate counter reconciliation; the script intentionally refuses that case.

## Outstanding user actions / external gates

- Identify an isolated test project/branch and authorize test migration execution (no credentials in chat). Provide access through the connector/locally configured credentials or run reviewed SQL in its SQL Editor.
- Approve the owner/store registry and explicit historical ID mapping using independent ownership evidence; current production has no `cc_store_id` column yet.
- Configure server-only `WIDGET_SESSION_SECRET` (32+ random characters) consistently for test runtimes and use synthetic owner identities / DNS or authenticated preview.
- A separately authorized preview deployment is needed for actual Vercel routing, auth, proxy IPs and multi-instance behavior. Production rollout remains a separate approval.

## Manual hosted verification checklist — only after separate approval

1. Confirm the target and take a recoverable backup. Recheck the read-only preflight against the actual schema before applying SQL; do not infer that the main project is a test environment.
2. Apply the three prepared migrations in the exact order above. Verify that all existing question IDs, timestamps and contents are preserved and that expected tables, columns, service-only RPC grants and restrictive owner policies exist.
3. Provision independently verified owner/store records, validate the explicit historical question ID mapping in default dry-run mode, and review its results before separately approving apply mode. Do this before initializing usage periods; existing periods require an explicit reconciliation plan.
4. With synthetic identities and content, verify anon cannot read/insert questions or call privileged RPCs; owner A cannot read owner B's questions; edited user_metadata does not change ownership or paid access; unmapped history remains preserved and inaccessible to unrelated owners.
5. Configure the server-only signing secret. Verify owner/DNS preview → widget session → question → persisted answer/usage → replay of the same request ID, with one question/event and one counter increment. Verify quota=1 across independent simultaneous PostgreSQL/API connections, plus AI failure, timeout and blocked requests without a charge.
6. On a separately approved Vercel preview, verify route resolution, shared auth/quotas, request body limits, platform client IP headers, CORS, session expiry/revocation and private source-file exclusion. The current public deployment was tested only by unauthenticated GETs and does not contain the prepared routes.

Safe local verification is complete at **74/74 PASS** plus a passing build. Hosted integration and production readiness cannot be declared complete while these gates remain. Do not proceed to Paddle without the user's confirmation.
