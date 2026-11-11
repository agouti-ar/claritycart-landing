# Stage 8 — product and store grounding

## Data flow

1. `clarity.js` reads bounded Product JSON-LD/microdata, then page metadata/DOM fallback. It sends title, description, literal price/currency, explicit availability, attributes, variants and image alt text. Current URL excludes query/fragment. When several Product entities exist, an exact current-page URL is preferred; explicitly unrelated product URLs are not treated as the current product.
2. The existing server widget/session/store/epoch check and atomic quota claim run **before** private context loading. `/api/chat` ignores client-supplied store/catalog/grounding overrides. It loads only the bound store's published snapshot through `load_cc_knowledge` with a 1.8-second deadline.
3. Server sanitization is repeated on every read. The current catalog product is matched by exact normalized store hostname/path; up to three relevant comparison alternatives are selected from at most 20 products. No cross-store search, HTTP crawl, embeddings service or URL fetch is performed.
4. Gemini receives server-owned grounding rules in `system_instruction`; facts, optional tone hint, buyer question and short history are separate JSON **data** in user content. Existing models/fallback/timeouts remain unchanged. The server request-completion transaction still writes usage/questions exactly once.
5. Missing migration, missing document, DB error or expired knowledge falls back to bounded page observations. Store-specific policies then remain unknown; no default shipping, return window, price or stock is invented. Successful retries return the original committed response rather than generating with a newly changed document.

The product is category-neutral: attributes and variants may describe electronics, furniture, jewelry, materials, clothing or other products. No shoe-size or clothing-specific grounding policy is used.

## Publishing actual merchant knowledge

There is no automatic live Shopify/catalog import in this stage. A verified store owner publishes a **customer-facing** snapshot through the protected API. Do not put credentials, internal notes or non-public wholesale information in documents intended for shopper answers. A dashboard import editor/commerce connector can call the same API later; no UI or provider integration is pretended to exist now.

`GET /api/knowledge?store_id=UUID` with `Authorization: Bearer <owner access token>` returns the current document/revision, or `available:false`. Never send a service key from the browser.

`POST /api/knowledge` with the same owner authorization:

```json
{
  "store_id": "<owned-store-UUID>",
  "expected_revision": null,
  "document": {
    "store": {
      "brand": "Example merchant",
      "shipping": "Ships within two business days.",
      "returns": "Returns accepted within 14 days.",
      "warranty": "Manufacturer warranty as stated on the product page.",
      "faq": [{"question":"Where do you ship?","answer":"Within the EU."}]
    },
    "products": [{
      "id": "lamp-01",
      "url": "https://your-store.example/products/desk-lamp",
      "title": "Desk lamp",
      "description": "Steel base, adjustable head.",
      "price": "49.00",
      "currency": "EUR",
      "availability": "in_stock",
      "attributes": {"Power":"10 W","Material":"Steel"},
      "variants": [{"title":"Black","price":"49.00 EUR","availability":"in_stock"}],
      "image_alts": ["Black desk lamp with an adjustable head"]
    }]
  }
}
```

Replace placeholders with the actual owned store/domain. Initial creation uses null revision. Subsequent writes must use the revision from GET; stale/concurrent updates return **409** rather than overwrite another revision. Publishing replaces that store's complete new snapshot, never store identity, settings, entitlements, questions or history. Only explicitly submitted normalized fields are saved; products need a title and unique same-store URL. Payload <=24 KiB, <=20 products. Write rate is persisted at 10/minute/owner.

Expiry defaults to seven days. Optional `expires_at` must be future and at most 30 days. The server timestamps the revision. An owner may intentionally publish empty store/products to stop using prior knowledge, with the expected revision; no automatic destructive cleanup is done.

## Limits, freshness and conflicts

- Title 240 chars; description 3,000 server / 4,000 page extraction; price 80; attributes at most 12 (40-char keys/120-char values); variants at most 6; alt texts at most 3. Store policy/FAQ fields have individual caps. Total encoded prompt <=24,000 UTF-8 bytes, including question/history/style; low-priority alternatives/history/descriptive text are reduced first.
- HTML/script/style blocks, common encoded controls, invisible/bidi characters and common instruction-like sentences are filtered. Prices must match a literal numeric/currency format; missing currency is not inferred from `$`. Availability is allowlisted; unknown remains unknown. Query strings/fragments are removed from product identity; merchant URLs are validated but **never fetched**, so this loader introduces no URL-fetch SSRF boundary.
- Catalog price/stock older than 24 hours are excluded even if descriptive/store knowledge remains valid. The entire expired document is excluded. Page values remain **observations**, not independently verified live inventory.
- Conflicting page/catalog prices/currencies/availability are removed from resolved facts and listed as conflicts. The model must disclose uncertainty, not choose a price/stock state. Literal formatting differences can conservatively produce a conflict; no currency conversion or inventory inference is attempted.
- Descriptive marketing text and old conversation are not evidence of current price/stock. Facts may not be changed by Brand Voice; custom voice stays a bounded, untrusted style hint rather than overriding system policy.

## Conversation and replay

Only the last six user/assistant messages are sent, with per-message limits. They are role-labelled data, not privileged provider messages and not verified facts. The widget appends real server-confirmed turns only; mock/blocked/error responses do not become factual history. A changed current product URL resets in-memory history. New requests have a client UTF-8 body budget; ambiguous retries keep their original payload/ID. History changes participate in request fingerprinting; absent/empty history preserves older fingerprint behavior. Legacy pending requests without product URLs remain replayable.

Raw conversation is not newly persisted as an analytics event or knowledge document; existing saved question behavior is unchanged. No full merchant/catalog content is logged. Gemini diagnostics retain model/category/HTTP status/code/reason but omit provider free-text messages that could echo new merchant context. Response grounding metadata contains only mode/source/missing/conflict field names.

## Security boundary and remaining limits

`cc_private.store_knowledge` has RLS and no direct anon/authenticated/service table access. Two public **invoker**, service-only RPC wrappers call private definer functions with empty search_path and owner/epoch checks. Document owner must still equal current store owner; a store transfer does not silently expose the previous merchant's snapshot.

Authenticated owner GET/POST and server-only load are separate. Client metadata cannot assign ownership or paid access. Local and Vercel use the same handler; `/api/knowledge` is rewritten to existing `/api/billing/knowledge`, avoiding another serverless function.

Prompt sanitization and channel separation are defense layers, **not proof that an LLM can never follow an injection or hallucinate**. Tests prove deterministic limits, source selection and prompt structure using a mocked provider. Real adversarial Gemini evaluations, real merchant import accuracy, inventory freshness guarantees and hosted routing are still integration work. No tools or URL-execution capabilities are enabled for the model.

## Prepared rollout (NOT applied)

1. Review `supabase/migrations/20261101100114_store_product_grounding.sql`. Depends only on Stage 1–4; Paddle and Stage 7 Analytics migrations are not prerequisites. Do not run a blanket db push that would apply other deferred migrations.
2. It creates one private table and two service-only RPC wrappers, without changing/backfilling existing rows. It is transactional; a rerun stops on existing objects rather than replacing data. Store an initial snapshot only after separate approval for real data writes.
3. After separately approved manual application, run `scripts/grounding-readonly-postflight.sql`. All RLS/access flags must be true and both wrappers invoker/service-only. Original unmapped history and its fingerprint must be unchanged.
4. After separately approved Preview deploy: owner publication → verified storefront question → Gemini answer → one usage → same-ID replay; then test missing/stale documents, price/stock conflicts, other store isolation and malicious product/history text.

No new environment variables are required. Existing Supabase service key, Gemini key and widget-session secret remain server-side. No SQL, live data change, commit, push or deployment was performed for Stage 8. Accepted Stage 7 and onboarding work remain preserved.

## Verification evidence

- Full local regression: **158/158 PASS**, no failures/skips (`node --test --test-concurrency=1 tests/*.test.js`).
- After the final current-product URL selection and price-format refinements: grounding unit suite **12/12 PASS**. It covers sanitization, price/stock conflicts, missing/stale/expired context, UTF-8 budget, cancellation fallback, instruction-channel isolation, extraction and conversation limits. Provider requests are mocked.
- The full run includes **10 grounding PGlite tests**: history preservation, RLS/grants, owner publishing/isolation, optimistic revision concurrency, invalid inputs, store/epoch checks, context→answer→single usage/replay, unavailable knowledge fallback, shared HTTP routes, history fingerprint compatibility and read-only postflight.
- Build **PASS** (20 allowlisted public assets); JS syntax checks and `git diff --check` **PASS**.
- Real Supabase application/publication, actual Gemini answer quality/adversarial injection resistance, and hosted Vercel routing are **not tested**. Local structural tests are not proof of live-model factual accuracy.

References: [Supabase functions](https://supabase.com/docs/guides/database/functions), [Gemini prompt design](https://ai.google.dev/gemini-api/docs/prompting-strategies).
