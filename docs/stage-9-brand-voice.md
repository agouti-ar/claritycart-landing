# Stage 9 — Brand Voice and custom style instructions

## Storage and compatibility

No migration is required. Values live in the existing owner-scoped `public.cc_stores.settings` JSONB and are saved through the protected account API:

```http
PATCH /api/account?store_id=<owned UUID>
Authorization: Bearer <owner JWT>
Content-Type: application/json

{"settings":{"tone":"formal","custom_instructions":"Use British English. Keep paragraphs short."}}
```

Canonical tones: `formal`, `friendly`, `concise`. Existing `professional`, `sales` and `custom` remain accepted; no legacy data is bulk rewritten or removed.

- `custom_instructions` is at most 400 characters. HTML/controls, common role/injection directives and requests to fabricate facts are filtered before storage and again before generation.
- Existing `custom_tone_prompt` remains supported (legacy storage validation <=1,000 chars; effective hint <=400). It is used for the old custom tone only when the canonical field is absent. An explicitly empty canonical field disables the old hint without deleting legacy data.
- Saving `tone` keeps `friendly_tone` consistent. A legacy Friendly toggle write sets canonical Friendly/Formal. Other settings (themes, colors, promo, white-label, etc.) remain merged and preserved.
- Settings writes use a server-owned `_cc_settings_revision` UUID inside existing settings JSONB. It is rotated on every protected settings write; clients cannot set it. The compare-and-update filter uses that short revision (or IS NULL for a legacy profile's first write), not the whole possibly large Unicode JSON in a PostgREST URL. A conflicting write during that server read/write window returns **409 SETTINGS_CONFLICT** instead of silently discarding a concurrent update. This is not a client draft-version/history system: a later intentional save after another completed edit still applies the submitted fields. Service-side maintenance writes must use the same revision discipline; public widget config never exposes this metadata.

Owner storage permissions and effective AI entitlement are separate. An owner may save a dormant profile through the API on Starter; it does not activate paid functionality. UI customization and effective custom voice require Pro/Business with active access. The normal server quota/subscription guard still runs before generation. Expired/paused stores cannot obtain AI access by changing tone.

## AI adapter boundary

`lib/ai-adapter.js` owns the tone whitelist, normalization, style sanitizer and construction of system instructions. `api/chat.js` retains the established Gemini transport/model fallback and delegates Brand Voice rules to this adapter.

Only fixed, server-controlled tone instructions enter `system_instruction` after the Stage 8 grounding policy. Free-form custom instructions remain bounded **untrusted style_hint data** in the JSON user content. They cannot replace the system policy. Buyer-provided tone/plan/instructions/systemInstruction fields do not choose the effective server voice.

- Formal: respectful, professional language without slang.
- Friendly: warm and approachable.
- Concise: short, direct answers without filler.
- Legacy Sales: documented benefits only; no invented urgency, advantages or claims.
- Legacy Professional/Custom remain usable.

All tones use the same grounded facts and conflict/missing-data rules. Custom instructions may change presentation/format only, never product facts, prices, stock, store policies, uncertainty disclosures or security. Existing emoji preference remains a system constraint. Prompt sanitization is defense in depth, not proof that a real model can never hallucinate or follow adversarial text.

Effective tone (only) is included in public widget config so the widget/demo can reflect the server profile. Canonical or legacy private instruction text is **not** exposed by `/api/config` or public live-sync responses. Existing developer/admin/mock controls remain; local tone flags do not grant paid rights.

## Dashboard

The existing Widget Settings area contains a Brand Voice section (`brand-voice-ui.js`) with tone select, 400-character instructions, counter, save button and status. It initializes from the owned account settings, not user_metadata. Private text is rendered through value/textContent.

- The form sends tone + instructions in one account PATCH and uses the normalized server response as confirmation.
- Saving disables controls and blocks duplicate submit. Failure preserves the draft and displays the error as text; a server conflict asks for reload rather than reporting success.
- Sanitized text is shown back to the owner with a cleanup notice. No real AI request/quota is consumed by saving settings.
- Starter/inactive profiles remain visible but customization is disabled. Legacy quick tone switch is preserved and synchronized for eligible stores.
- Widget tone preview/broadcast occurs after successful account persistence. Instruction text is not broadcast to storefront visitors. Formal/Concise do not get overwritten by the old friendly boolean in the client tone resolver.

## Verification and external gates

PGlite/unit tests cover persistence, legacy compatibility, sanitized/invalid input, ownership, dormant Starter preferences, Business/Pro restrictions, fixed instruction channels, equal grounded facts, concurrent settings writes and UI save/failure/duplicate behavior. Gemini responses are mocked; differing prompt styles are not evidence of live-model response quality.

Real Supabase account PATCH/JSONB compare behavior, published Vercel widget config, visual browser testing and live Gemini tone/adversarial evaluations remain integration checks. No new environment variables or SQL migration are needed for Stage 9. Existing Stage 7/8 migrations are still separate prepared changes; do not apply a blanket db push.

No live database write, commit, push or deploy was performed. All prior uncommitted features/files remain preserved.

## Local results

- Full regression: **171/171 PASS**, no failures/skips (`node --test --test-concurrency=1 tests/*.test.js`).
- After the final short-revision compare-and-update refinement: settings/entitlement/parity suite **30/30 PASS** (`tests/brand-voice.test.js`, `tests/entitlements.test.js`, `tests/server-parity.test.js`).
- Stage 9 adds 8 PGlite/server-adapter tests and 4 UI unit tests. Provider calls are mocked. Channel separation and equal source facts across tone prompts are tested; real model behavior is not.
- Build **PASS** (21 allowlisted public assets); dashboard inline JS syntax, module syntax and `git diff --check` **PASS**.
- Live Supabase HTTP filters/owner edits, deployed Vercel behavior, real browser rendering and actual Gemini voice/adversarial quality: **not tested**.
