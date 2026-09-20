# Creem Live Verification Evidence

Date: 2026-09-20 · Environment: local MonetPlane (dev server) + real Creem
test-mode API (`test-api.creem.io`) with real credentials + ngrok webhook
tunnel. All traffic below ran against the LIVE Creem platform.

Connection: `pconn_62ad8c6f-…` (Creem Sandbox, API key
`creem_test_56NM…`, webhook `wh_test_5BfFVXqEGJh9yfWo4QaXHE` created via
`POST /v1/webhooks` with the signing secret captured from the one-time
create response).

## Live-docs audit (before verification)

The adapter matched the current documented surface on auth
(`x-api-key`), environments, checkout (`POST /v1/checkouts` with
`product_id`/`request_id`/`units`/`customer`/`success_url`/`metadata`),
webhook signing (`creem-signature`, HMAC-SHA256 over raw body), retry
semantics, and subscription cancel. Two honest-direction gaps were fixed
pre-verification (#100/PR #101: refund capability + update-event
mappings), and the live run surfaced the real refund response shape
(#102/PR #103).

## Journey evidence (all live)

| Step | Evidence |
|---|---|
| Products at Creem | `prod_6xohEAas5jZlP1OPcMDOVD` (one-time $29.00) and `prod_3Yovyv9uuM5uaLVx45S6Eu` (monthly $9.00) created via `POST /v1/products` (live-verified schema: `billing_type: onetime\|recurring`, `billing_period: every-month`, cents) |
| Webhook endpoint | Created via API (`POST /v1/webhooks`) pointing at the ngrok tunnel → `/api/webhooks/<connectionId>`; signing secret stored encrypted in the connection |
| Connect + diagnostic | Console connect (apiKey + webhookSecret); configuration diagnostic passed |
| Catalog mapping | Connection metadata `catalog[priceId].productId` → Creem product id (adapter contract) |
| Routed SDK checkout | `POST /api/checkout` without `providerConnectionId`; router resolved product routing → Creem session `ch_Dh9KpQoiN27TEyCCXsGcb` (`creem.io/test/checkout/...`) |
| Real payment | Creem hosted checkout (Stripe-iframe card form), test card `4111 1111 1111 1111` → **Payment Successful**, redirected to successUrl with `request_id=ord_97eb7f75…` |
| Real webhook | `checkout.completed` delivered through ngrok → signature verified (HMAC `creem-signature`) → inbox **processed**; order `ord_97eb7f75…` → **paid**; payment `tran_7j00sgm2DkjvIY9wfqaIh` succeeded $29.00; entitlement `creem_pro_access` → **active** |
| Refund (real execution) | Console refund → `POST /v1/refunds` **executed at Creem** (subsequent direct calls return `IDEMPOTENCY_DUPLICATED` because the transaction is fully refunded — proof the first call went through) |

## Findings fixed during verification

1. **#100 / PR #101** — refund capability true + implementation;
   `subscription.update`/`.trialing`/`.paused` → `subscription.updated`.
2. **#102 / PR #103** — the real refund contract: request body accepts
   ONLY `transaction_id` (`metadata` → 400 "property metadata should not
   exist"); the 200 response is `{ status }` with NO refund id (the
   authoritative id arrives via `refund.created` webhooks). Adapter now
   sends the minimal body, synthesizes a deterministic
   `refund:<transaction_id>` id, and maps the full status enum.

## Qualifications (honest limits)

- **Test mode only**; production endpoints and live charges not exercised.
- The `refund.created` webhook did not arrive during the session (Creem
  processes refunds asynchronously; the duplicated-refund responses prove
  execution). The mapping is contract-tested; live delivery remains to be
  observed on a future refund.
- Subscription lifecycle was provisioned (monthly product exists) but the
  live subscription checkout/cancel run was cut short by a local
  dev-database reset (integration-test TRUNCATE hit the dev DB);
  one-time payment + refund evidence above is complete.
- Local dev hygiene note: point integration runs at a dedicated database —
  the dev database was wiped twice this session by stray test runs.
