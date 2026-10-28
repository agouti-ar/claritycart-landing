# Stage 5 — Paddle Billing server implementation (2026-10-28)

Local implementation only. No commit, deployment, live migration, Paddle account modification, checkout or payment was performed. Existing Stage 1–4 migrations and legacy questions were not changed.

## Architecture and authority

Existing Express/Node/Supabase architecture is retained. `api/billing/[...path].js` delegates to the same Express app as Local. The signature route is mounted with a 256 KiB raw-body parser BEFORE express.json; other billing routes retain the existing 32 KiB JSON limit. No Paddle SDK dependency was added: fixed-host HTTPS fetch and Node HMAC are used.

`owner JWT → owned store → server-selected price → server-created transaction → Paddle Checkout → signed webhook → atomic billing state + cc_stores entitlement`.

- App signup alone does not start the trial. A confirmed Paddle checkout creates a trialing subscription. An owned/provisioned store is a prerequisite; Google/store onboarding and frontend wiring remain their own work.
- A trial price must have an exactly seven-day FREE, payment-method-required trial. Its recurring amount is charged after trial conversion. The server re-reads/validates the Paddle price before checkout, rather than accepting a frontend price or amount.
- Six monthly price IDs are required: regular and trial variants for each Starter/Pro/Business plan. Separate regular prices allow a returning owner to purchase without receiving another trial. Optional annual checkout uses another six IDs. A price ID cannot map to two plan/interval/trial configurations.
- Trial eligibility is owner-wide, checked under a transaction-scoped owner lock, with a stable owner/subscription trial record. Trial access is capped to the original seven days even if a later event extends the provider trial. Open/finished trial checkouts conservatively reserve eligibility; abandoned or ambiguous checkouts require resuming/reconciling rather than creating more trials.
- Paddle Billing uses dotted events: `subscription.created`, `transaction.completed`, `subscription.canceled`, etc. Classic `subscription_created` / `payment_succeeded` are not treated as Billing entitlement events.
- Active paid access requires both an active subscription snapshot AND a completed, positive-value, compatible-plan payment covering the current time. `transaction.paid`, frontend success and zero-value trial checkouts do not grant paid access. Initial completed checkout can use the signed subscription period if the transaction omits billing_period. Renewal needs corresponding payment coverage and cannot extend from status alone. Future-period payments do not unlock current unpaid access.
- Trial/paid expiration is enforced by existing access_until checks on every AI request, without depending on a cleanup cron. Past-due, paused and canceled subscriptions fail closed. Scheduled cancellation preserves access only until the already-proven end; it never extends it.
- Plan changes are submitted to Paddle with immediate proration and `on_payment_failure=prevent_change`; trial changes use do_not_bill. The HTTP response is 202/pending_webhook, not a local entitlement grant. Downgrades can retain existing higher-tier paid coverage. Monthly quota anchors/counters are not reset by plan changes or renewals; annual payment still uses the existing MONTHLY quota arithmetic. First conversion from trial establishes the paid billing anchor.
- A manual super-admin pause is represented by billing_hold, so incoming renewal events cannot undo it. Existing admin/manual entitlement functions, ADMIN_EMAILS and widget mock/promo/white-label tools remain present. Super-admin manual edits remain privileged overrides; Paddle projection corrects billing-controlled fields on the next event.

## Database model

Prepared migration: `supabase/migrations/20261028184410_paddle_subscription_lifecycle.sql`. Apply ONLY this new migration after separately approving the database operation. Do not re-run the old Stage 1–4 bundle.

The migration adds paddle_subscription_id/paddle_status/billing_hold to cc_stores, plus six RLS-enabled private tables:

| Table in cc_private | Purpose |
|---|---|
| paddle_prices | Immutable, server-verified price → plan/interval/trial mapping; old IDs retained |
| paddle_checkouts | Owned checkout intent, request id, bound provider transaction, ready/pending/failed state |
| paddle_subscriptions | Provider status/period/customer/subscription and immutable store/owner binding |
| paddle_trials | One original trial window per owner |
| paddle_payments | Minimal transaction status/amount/currency/coverage, without card/address payloads |
| paddle_events | Event-ID dedupe, payload hash and processing metadata, not whole webhook PII |

No existing question is deleted, updated or assigned. Legacy history remains unmapped. New billing RPCs are invoker wrappers to private definer functions, executable only by service_role. Ordinary authenticated users have no direct private billing-table or privileged-RPC access.

One database transaction records each accepted event and updates the entitlement projection. Same event ID/body is a no-op; changed body for the same ID is rejected. Older entity timestamps do not overwrite newer snapshots. Payment-before-subscription is supported. Unknown bindings return 503 and roll back their ledger insert, so Paddle retries can apply them once the binding exists. An old canceled subscription cannot overwrite its replacement.

Checkout and subscription association is validated using the server-stored transaction ID. Client custom_data/domain/email alone never establishes ownership. An existing subscription is linked by provider ID and immutable server-owned checkout/store records.

No external request is retried blindly after an ambiguous create-transaction timeout: the intent remains pending and is exposed as CHECKOUT_PENDING_RECONCILIATION. This can require an operator to inspect/cancel the Paddle transaction and repair the intent before creating another checkout. No undocumented Paddle idempotency behavior is assumed.

Financial records use restrictive foreign keys intentionally: hard deletion of an owner/store with billing history needs a reviewed account-closure/retention workflow. It does not silently cascade away payment evidence. Never-billed admin cleanup behavior remains unchanged. Refund/chargeback/100%-discount policies and automated reconciliation jobs are not claimed implemented in this first server phase; review these before production billing.

## Server API

Every owner route requires `Authorization: Bearer <Supabase access token>` and checks store ownership using getUser, not editable metadata. Store ID must be supplied explicitly.

| Method/path | Input / behavior |
|---|---|
| GET /api/billing/status?store_id=UUID | Local subscription/trial availability and recoverable open checkout |
| POST /api/billing/checkout | `{store_id,request_id:UUID,plan:"starter"|"pro"|"business",interval:"month"|"year"}`; returns transaction_id/checkout_url |
| POST /api/billing/cancel | `{store_id}`; cancellation at next billing period, pending webhook |
| POST /api/billing/undo-cancel | `{store_id}`; removes an existing scheduled cancellation via Paddle |
| POST /api/billing/plan | `{store_id,plan,interval}`; server price mapping, pending webhook |
| POST /api/billing/webhook | Exact Paddle body + Paddle-Signature; no Supabase JWT |

Checkout request UUID is stable across retries. A new UUID cannot bypass an already-open checkout; ready checkout URLs can be recovered/reused for the same plan. Arbitrary frontend paid/status/price/quota/custom_data fields are rejected. The older `/api/webhook/cancellation` is feedback/notification only and is not subscription cancellation.

## Paddle Sandbox setup required from the owner

1. Open Paddle Sandbox, complete its account/setup requirements, and create products for Starter/Pro/Business. Configure recurring prices consistent with the advertised amounts (currently monthly USD 9.99/29.99/79.99). Annual price math/landing correctness still needs the planned pricing review; do not silently use mismatching totals.
2. For EACH plan create a regular monthly price without trial, and a matching monthly price with a free seven-day, card-required trial. The trial price itself recurs at the regular amount after trial. Set quantities to one. Use optional annual pairs only when annual checkout is deliberately configured. Do not mutate in-use price meanings; create/review new IDs instead.
3. Create a Sandbox server API key with the least permissions covering price.read, transaction.write, subscription.read and subscription.write. Configure it only as a server secret. Do not send credentials in chat. Sandbox/live keys, webhook secrets and price IDs must remain separate.
4. Set an approved/default payment-link page and PADDLE_CHECKOUT_URL. That page needs the frontend Paddle.js initialization using the Sandbox client-side token and Paddle Sandbox mode, plus handling the returned transaction ID/_ptxn. This server-only change does not yet wire the existing UI buttons to Paddle. The client token is publishable, not the API key.
5. Add a Sandbox notification destination at `https://<approved-host>/api/billing/webhook`. Subscribe to subscription.created, subscription.updated, subscription.trialing, subscription.activated, subscription.canceled, subscription.paused, subscription.resumed, subscription.past_due; and transaction.completed, transaction.paid, transaction.payment_failed. Copy THAT destination's signing secret to PADDLE_WEBHOOK_SECRET.
6. Paddle cannot deliver through interactive Vercel Deployment Protection. A previously generated one-hour browser share link is not a permanent webhook configuration. Arrange a separately approved, narrowly scoped/public Sandbox webhook endpoint or protection exception while retaining signature verification; do not disable protection on unrelated routes. Actual hosted raw-body behavior must be tested after an approved deployment.
7. After separately approved migration/configuration/Preview deployment, run a real Sandbox Checkout using Paddle's documented test payment methods. Verify trial, first payment, renewal, cancellation and plan changes using actual IDs created by this server. Simulator signatures can be tested independently, but random simulator IDs deliberately do not grant access to arbitrary stores. Unknown bindings require retry/replay, not manually weakening the checks.
8. Use the Paddle delivery log to inspect/replay missed events. An automation for periodic API reconciliation is not installed. Do not enable live payments until missed-event recovery, refund/chargeback and account-closure policies have been reviewed.

## Environment variables

Existing SUPABASE_URL/SUPABASE_SERVICE_KEY/ADMIN_EMAILS remain. Add server-only variables to LOCAL and the approved Vercel PREVIEW environment:

```dotenv
PADDLE_ENVIRONMENT=sandbox
PADDLE_API_KEY=<sandbox server key>
PADDLE_WEBHOOK_SECRET=<notification destination secret>
PADDLE_CHECKOUT_URL=https://your-approved-domain.example/billing
PADDLE_PRICE_STARTER_MONTHLY=<regular price ID>
PADDLE_PRICE_STARTER_MONTHLY_TRIAL=<7-day free trial price ID>
PADDLE_PRICE_PRO_MONTHLY=<regular price ID>
PADDLE_PRICE_PRO_MONTHLY_TRIAL=<7-day free trial price ID>
PADDLE_PRICE_BUSINESS_MONTHLY=<regular price ID>
PADDLE_PRICE_BUSINESS_MONTHLY_TRIAL=<7-day free trial price ID>
```

Optional annual equivalents replace MONTHLY with YEARLY (regular + _TRIAL). Production configuration is a later explicit rollout: environment=production, live IDs/key and a different live signing secret. Missing configuration returns a closed 503, not free paid access. Frontend Paddle.js will additionally need its Sandbox client token; no new client-token env variable is read by current server code.

## Verification evidence and limits

- Full local suite: **99/99 PASS**, build PASS.
- After the final future-period coverage guard, targeted billing suite including the read-only postflight check: **17/17 PASS**. Signature exact-byte/tamper/replay/timestamp, owner auth, checkout retries/concurrency/ambiguous transport, trial→payment→renewal→cancel, repeated-trial protection, expiry, upgrade/downgrade, manual pause, out-of-order/stale/unknown events, private grants, and raw HTTP parsing are covered on PGlite/mocked Paddle.
- Synthetic legacy rows are seeded before all migrations; all 20 remain unchanged/unmapped with the same fingerprint after the billing lifecycle.
- No real Paddle Sandbox checkout, money movement, notification delivery, hosted Vercel body parser or independent hosted Postgres connection race was tested. Tests on PGlite are not those external checks.
- No migration has been applied to the main Supabase project, no environment has been edited, no commit/deploy/push was made in Stage 5.

References: [Paddle signatures](https://developer.paddle.com/webhooks/about/signature-verification/), [trial setup](https://developer.paddle.com/build/trials/create-trial/), [provisioning](https://developer.paddle.com/build/subscriptions/provision-access-webhooks/), [transaction creation](https://developer.paddle.com/api-reference/transactions/create-transaction/), [subscription updates](https://developer.paddle.com/api-reference/subscriptions/update-subscription/).
