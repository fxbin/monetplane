# P2 Gate (#68) Dogfood Evidence — Local Run

Date: 2026-09-18 · Branch: `chore/p2-gate-dogfood` · Base: latest main
(includes #49 ADR, #74 isolation, #60 router, #61 developer events, #62
usage, #63 credit buckets, #64 pricing v2, #65 SDK package, #66 audit,
#67 analytics).

Environment: local dev server + real PostgreSQL (`monetplane_dogfood`,
fresh migration), real browser for console flows, real HTTP for SDK and
webhook endpoints. **No database edits were used to create dogfood
state** — one documented test-harness injection is explicitly qualified
below.

## Real product journey (console + SDK)

| Step | Surface | Evidence |
|---|---|---|
| Register application | Console `/applications/new` | "Dogfood App" (`app_a84f7d6b…`) created; console auto-selected it and switched to Sandbox; server key shown once (`mp_app_B9oso…`, recorded, never re-exposed) |
| Configure environments | Console | Environment toggle present; provider mode locked to console environment |
| Connect provider | Console `/providers/new` | Creem **Sandbox** connection created through the console with explicitly-labeled placeholder test credentials (real credentials unavailable — see Qualifications) |
| Create product/price/benefits | Console Product Builder | "Pro License" (`pro-license`), one-time $49.00, entitlement `pro_access`, provider routing — all through the 5-step wizard, no direct DB edits |
| Developer webhook endpoint | Console `/webhooks` | Endpoint `http://127.0.0.1:4599/monetplane` (Sandbox HTTP allowed), signing secret shown once |
| SDK integration | Packaged SDK over HTTP | `upsertCustomer` → 201; checkout submitted **without `providerConnectionId`** (payment router path) |
| Routed checkout | SDK + router | Router resolved the product-routed Creem connection; the provider call then failed against the real Creem API with placeholder credentials — expected, see Qualifications |
| Complete payment (qualified) | In-process on the same DB | Mock connection (test-harness injection, qualified below) + `processProviderWebhook` with a signed payload → order `ord_7370c336…` paid, payment `pay_9d7d27d0…` recorded |
| Developer lifecycle event | #61 fan-out | `payment.succeeded` (envelope v1) delivered to the console-configured endpoint with HMAC signature `v1=ea0e906e…`; verified in the receiver log |
| Entitlement check | SDK `checkEntitlement` | `{ granted: true }` for `pro_access` → payment→entitlement effect chain proven |
| Credits/usage | SDK | Balance read OK; `reportUsage` for an undefined meter correctly failed with typed `UsageMeterNotFoundError` (fail-closed) |
| Refund | Console admin API | Refund request for the mock-provider payment correctly **failed closed** ("Provider capabilities are unavailable") because the production runtime intentionally excludes the mock adapter |

## Operational correctness

- **Full trace**: checkout → provider webhook (signed) → payment/order
  paid → entitlement grant (`pro_access` linked to
  `ord_7370c336…` in customer detail) → developer event (signed,
  versioned envelope) — all visible in the console: Payments row,
  Overview KPIs ($49 revenue), Events timeline (`payment.succeeded`),
  Revenue page.
- **Customer workspace**: entitlement section shows the active grant;
  payments section shows 0 because the mock webhook payload did not
  carry a customer reference (payload limitation, not a product
  defect — customer-linked flows are covered by integration tests).
- **Audit history**: `/audit` shows `provider.connected`,
  `webhook_endpoint.created` (and would show refund/credit actions on
  success) with actor, correlation ids, and redacted metadata. No
  plaintext secret appears in any audit row.
- **Analytics**: Revenue page reflects the observed traffic; single
  currency (USD) so no mixed-currency aggregation was exercised live —
  separation is covered by `tests/integration/analytics-v1.test.ts`.

## Reliability/security

- CI (pnpm) reaches all verification stages — current main runs green
  (#54).
- Full integration suite green including rollback coverage (#47): last
  full local run 113/113.
- Fresh migrations + repeatability: `monetplane_dogfood` was created
  fresh and migrated once; repeat-migration no-op proven per release
  (CI runs `pnpm db:migrate` twice every push).
- Secrets: app key displayed exactly once at creation; provider/webhook
  secrets write-only after creation; audit metadata redacted (tested in
  `tests/integration/operator-audit.test.ts`).
- Isolation: cross-application and cross-environment isolation covered
  by `environment-isolation.test.ts`, `analytics-v1.test.ts`, and
  entity-level tests from #74.

## Qualifications — why #68 stays OPEN

Per the exit rule, external-provider capabilities that cannot be
exercised remain explicitly qualified; mocks are never presented as
real-provider proof:

1. **No real provider credentials** (Creem/Waffo sandbox keys). The
   live checkout reached the real Creem API and failed with placeholder
   credentials. This is the same blocker tracked by #41. Real-provider
   webhook ingestion, refunds, and subscription lifecycle mutations
   remain unproven against live providers.
2. **Mock completion is a test-harness injection**: the mock adapter and
   mock connection are intentionally NOT creatable through console/API
   surfaces (verified — the provider list offers only Creem/Waffo).
   The payment-completion step ran in-process against the same dogfood
   database and is labeled as such everywhere above.
3. **Subscription lifecycle trace** (activation/renewal/cancellation
   through a live provider) is #41-qualified; recurring flows are
   covered by the integration suite with the mock adapter.
4. **Sustained production dogfood** (weeks of real traffic) is beyond a
   single gate run.

## Follow-ups captured

- Real Creem/Waffo sandbox credentials → #41 (open).
- Mock webhook payloads could carry `monetplane_customer_id` to link
  payments to customers in the console trace view (minor; integration
  tests cover the linked path).
