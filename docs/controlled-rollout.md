# Controlled Stage 1–4 rollout — 2026-10-28

## Authorized scope

One local commit on `feat/security-and-parity` is authorized. No push, SQL execution on Supabase, DNS change, preview/production deployment or Paddle work is authorized. All 20 existing questions are confirmed by the user to be their test records and must remain UNMAPPED. The CSV now records KEEP_UNMAPPED with blank owner/store fields; the optional explicit-mapping template is not part of this rollout.

## Single SQL artifact and source of truth

Open `scripts/supabase-stage1-4-rollout.sql` and copy the ENTIRE file into SQL Editor only when ready for the coordinated production operation. Do not run the three originals as well.

`node scripts/build-rollout-sql.js` generates this file directly from, in order:

1. `migrations/001_chat_request_idempotency.sql`
2. `supabase/migrations/20261027142546_server_entitlements_and_monthly_quota.sql`
3. `supabase/migrations/20261027152654_widget_security_and_store_binding.sql`

The generator preserves every migration body verbatim after LF normalization, removing only the three outer transaction pairs and adding a single shared transaction. Each section includes its source hash. No migration logic is recreated manually. Added rollout guards reject prior/partial application, lock questions, require exactly 20 original rows, and compare all five original fields before COMMIT. The temporary baseline table is session-local and dropped on commit. No original IDs, content or timestamps are overwritten; no mapping or store provisioning is performed.

Repeat behavior: a successful previous run or partial installed schema produces `ROLLOUT_ALREADY_OR_PARTIALLY_APPLIED` before DDL. Do not suppress that error or add IF NOT EXISTS indiscriminately. After any error execute `ROLLBACK;` in the same SQL session if it remains in an aborted transaction, inspect the error and schema, and only retry when its cause is understood. A failed atomic transaction leaves no partial migration. Schema drift/name collisions also abort rather than silently merging incompatible definitions. The script is a controlled one-time migration, not a general repair tool.

Destructive-operation review: no top-level DELETE/TRUNCATE/DROP of existing data, no auth.users changes and no store_settings rewrite. The unchanged Stage 3 function contains a DELETE that later expires rows older than one day from the NEW private rate-limit bucket table. Stage 2 request-completion functions INSERT new questions and UPDATE request/quota state only when called later. These function bodies are not executed by migration creation. Grants/revokes intentionally tighten access and are an operational compatibility change.

## Manual SQL order and PASS/FAIL

1. Confirm target `vzmpwstfddznsvypudhj`, obtain a recoverable backup, and stop writes/old clients. The OLD published API/browser cannot be assumed compatible after permissions change. Applying SQL alone does not update the public widget. Until separately authorized deployment, keep new traffic disabled.
2. Run `scripts/supabase-readonly-preflight.sql`. PASS: expected five original question columns, bigint identity id, required domain/text, existing PK, no unexpected triggers/constraints/object collisions; 20 rows; Stage 1/2 absent. Any drift means stop and review. RLS being enabled does not make the current broad policies safe; the Stage 3 restrictions are required.
3. Run `scripts/supabase-history-fingerprint.sql`, retain its count/hash without customer content.
4. Run the entire generated `scripts/supabase-stage1-4-rollout.sql` ONCE. PASS requires no SQL errors, COMMIT, and preservation output PASS / 20. Any exception is FAIL; do not continue to traffic or deployment as though it succeeded. SQL Editor may display only the final statement result, so also run the explicit postchecks.
5. Re-run the fingerprint: exact original count/hash equality is PASS. Any mismatch is FAIL and requires investigation/restore planning, not blind rerunning.
6. Run `scripts/supabase-stage4-postflight.sql`. PASS: 11 check rows all true, and five RPC rows with every boolean true. Missing rows, errors or any false are FAIL.
7. Read-only check: `select count(*) as rows, count(*) filter(where cc_store_id is not null or cc_request_id is not null or cc_period_start is not null) as assigned from public.questions;` Expect rows=20, assigned=0 before new traffic. DO NOT run legacy-question-mapping.sql for these 20.
8. Separately provision a verified owner/store and intentional server-owned entitlement for NEW synthetic tests. This is not performed by the bundle and needs its own data-operation approval. Keep legacy rows unmapped. Retain old settings records; migration does not automatically transfer their preferences into the new registry.

Postflight SQL was executed only against local PGlite. No SQL in this follow-up was executed on Supabase.

## Environment variables actually read by runtime code

| Variable | Production | Preview | Development | Purpose |
|---|---|---|---|---|
| SUPABASE_URL | required | required for DB/auth tests | required for local server | Target DB/auth API URL |
| SUPABASE_SERVICE_KEY | required, secret | required, secret for approved target | required, secret | Server-only DB/auth privileges |
| GEMINI_API_KEY | required for real AI | required for real AI tests | set for local generation | Server-only provider key |
| WIDGET_SESSION_SECRET | required NEW secret | required NEW secret | required for local sessions | At least 32 random characters; same across instances sharing sessions, separate across isolated environments |
| ADMIN_EMAILS | explicitly configure | explicitly configure | explicitly configure | Comma-separated admin allowlist; existing two-account fallback retained |
| TELEGRAM_BOT_TOKEN | optional secret | omit unless explicitly testing notifications | optional | Existing cancellation-feedback notification |
| TELEGRAM_CHAT_ID | optional with bot token | omit unless explicitly testing notifications | optional | Existing notification destination |
| PORT | Vercel-managed/not needed | Vercel-managed/not needed | optional; default 3000 | Local listener |
| VERCEL | supplied by platform | supplied by platform | leave unset | Chooses trusted platform IP source; do not simulate production by setting it locally |

Read-only Vercel env metadata at preparation time listed only GEMINI_API_KEY targeting production. It did not confirm the DB credentials, signing secret or allowlist for Production/Preview/Development. No values were requested/decrypted/printed and no variables were created. Do not assume existing production AI credentials are automatically available to Preview. Configure secrets directly in Vercel, never in chat, Git, public HTML or NEXT_PUBLIC-style variables.

Development without GEMINI_API_KEY retains the existing remote production proxy behavior in lib/local-chat.js; do not use that mode for isolated synthetic write tests. No automatic .env.test loading exists in this plain Node app. The static HTML also contains existing hardcoded main-project Supabase URLs/public anon credentials and the widget defaults to the production AI origin. Server env changes alone do NOT isolate the browser. For a narrow widget preview use explicit data-api/data-config pointing to that preview and an authorized preview session; do not put access tokens into a public snippet. Dashboard/auth isolation requires a separately reviewed client configuration step or explicit permission to use the main project. This follow-up does not change runtime behavior to conceal this limitation.

## Exact Preview command — DO NOT RUN YET

Assumes Vercel CLI is installed, authenticated and authorized for agouti-ar. From PowerShell:

```powershell
Set-Location -LiteralPath 'D:\VS Code Projects\claritycart-landing'
$env:VERCEL_ORG_ID = 'team_5IktyNHmWsx3T4Fzj6ZKYJ3R'
$env:VERCEL_PROJECT_ID = 'prj_4eyIZV4I145kufxi5zn4Gb9pWi0I'
vercel deploy --target=preview --scope=agouti-ar
```

This command creates an external preview and is provided for later approval, not executed. Do not add --prod, promote, push to main, or alter production aliases. Before running, check correct branch/commit and clean status, approved Preview env targets, reviewed file upload contents and team authorization. .env files (except the placeholder example), .vercel files and build output are gitignored. Verify upload excludes secrets; .gitignore alone is not a reason to skip checking the deployment payload. No Vercel CLI installation/authentication or linking changes were performed as part of preparation.

## Remaining Stage 4 gates

Pre-commit verification: full sequential suite `node --test --test-concurrency=1 tests/*.test.js` passed **80/80**, zero failures/skips/cancellations; `npm run build` passed (14 explicitly allowed assets). This includes three generated-bundle tests: body/source identity, preservation/postflight/replay rejection, and transaction rollback/safe retry. Source and staged-content secret scans found no actual .env secret values, secret token patterns or private keys. Existing public anon credentials in client HTML are intentional client configuration and were not removed; .env itself is excluded. No runtime application behavior was changed for the commit.

Manual migration/postchecks and approved store provisioning; separately authorized protected Preview with correct browser/backend targets; actual Supabase JWT/two-owner RLS tests; DNS/owner preview → signed session → AI → one event → same-ID replay; real independent-connection quota races/month boundary/failure/timeout; platform routes/CORS/IP/body limits/static exclusion. DNS verification, existing admin/mock/promo/white-label tools and architecture are unchanged. Commit does not mean these hosted checks passed. Paddle stays blocked pending separate user confirmation.
