# PayPal Live Verification Evidence

Date: 2026-09-26 · Environment: real PayPal **sandbox** API
(`api-m.sandbox.paypal.com`) with real sandbox REST credentials owned by the
operator. Adapter: `src/modules/providers/adapters/paypal.ts` (PSP model —
Orders API for one-time, Billing Subscriptions for recurring).

Credentials used (redacted): client id `AQIqdINjvXUE…KscE0`, client secret
`ENQEm130pBoy…Q48wYASfkTh` (sandbox-only; never committed — supplied through
the console connection form and encrypted at rest).

## Live-docs audit (before verification)

The adapter targets the documented surface: OAuth2 client credentials
(`POST /v1/oauth2/token`), Orders (`POST /v2/checkout/orders` with
`custom_id` correlation + `experience_context.return_url/cancel_url`),
Billing Subscriptions (`POST /v1/billing/subscriptions` with `plan_id` +
`custom_id` + `application_context`), subscription cancel
(`POST /v1/billing/subscriptions/{id}/cancel`), captures
(`GET /v2/payments/captures/{id}`), refunds
(`POST /v2/payments/captures/{id}/refund`), and webhook signature
verification via `POST /v1/notifications/verify-webhook-signature`.

## Journey evidence (all live sandbox)

| Step | Evidence |
|---|---|
| OAuth | Client-credentials token issued (`A21AAJnNVft…`, 97 chars) — the adapter's token caching + 401 retry path is built around this flow |
| Catalog product | `PROD-0KE38543SH558661R` via `POST /v1/catalogs/products` (`type: SERVICE`, `category: SOFTWARE`) |
| Plans (all `ACTIVE`) | Monthly `P-5PF275943F114484UNK3YJ2Q` ($19.00), Yearly `P-22R6920611520231PNK3YKBQ` ($190.00), **Weekly** `P-8JG9653073984554TNK3YKBY` ($5.00), **7-day trial** `P-2J825314YX128993LNK3YKIQ` (TRIAL $0 + REGULAR month) — weekly and trial `tenure_type`/`sequence` schemas verified live |
| One-time order | `71B07043FK731281H` via `POST /v2/checkout/orders` with `custom_id: monetplane_order_id:…\|monetplane_customer_id:…` (84 chars — fits the 127-char limit) |
| Checkout link shape | The approve link is `rel: "payer-action"` on current responses (older docs say `approve`); the adapter accepts both rels |
| Subscription | `I-3C1C23VAAS5T` via `POST /v1/billing/subscriptions` on the monthly plan → status `APPROVAL_PENDING`, hosted approval URL at `www.sandbox.paypal.com/webapps/billing/subscriptions` |
| Cancel endpoint | `POST /v1/billing/subscriptions/{id}/cancel` — route+auth verified; PayPal returned "not found/not cancellable" because the subscription was `APPROVAL_PENDING` (only `ACTIVE` subscriptions are cancellable) |
| Webhook verification | Contract-tested against the `verify-webhook-signature` request shape; `webhookId` is a connection credential (console field added) |

## Capability mapping (post-verification)

`one_time_checkout`, `recurring_subscription`, `monthly_interval`,
`annual_interval`, `weekly_interval`, `trial_periods`,
`provider_hosted_checkout` — verified by the live calls above.
`subscription_cancel`, `refund` — endpoint contracts exercised (cancel) and
schema-stable (refund); see qualifications. `subscription_update`
(`/revise`) and `customer_portal` — not supported by this adapter v1.

## Setup walkthrough (sandbox)

1. PayPal REST app → client id + secret → console connection (test mode).
2. Create product + plans via API (commands mirror the adapter's expected
   schemas; ids go into the connection's `catalog[priceId]` metadata as
   `{productId, planId}` — same mapping contract as the Creem adapter).
3. Create a PayPal webhook pointing at
   `https://<monetplane-host>/api/webhooks/<connectionId>` (needs a public
   URL, e.g. an ngrok tunnel), then store its `WH-…` id in the connection.
4. Sandbox buyer approval: open the returned `payer-action`/`approve` URL in
   a browser, pay with the sandbox buyer account — the resulting
   `PAYMENT.CAPTURE.COMPLETED` / `BILLING.SUBSCRIPTION.*` webhooks drive
   MonetPlane state through the normal inbox.

## Qualifications (honest limits)

- **Sandbox only**; live-mode endpoints were not exercised.
- The buyer-approval step (real `PAYMENT.CAPTURE.COMPLETED` capture, refund
  execution on a real capture, and cancel of a truly `ACTIVE` subscription)
  requires the sandbox buyer account to complete the hosted flow; the
  webhook delivery leg additionally needs a public tunnel. The request
  shapes are contract-tested (`tests/provider-contract/paypal-adapter.test.ts`)
  and the creation-side endpoints above were exercised live. To finish the
  loop: run step 4 with the sandbox buyer account and append the captured
  evidence here.
- `subscription_update` intentionally unsupported (PayPal revise supports
  quantity/shipping and plan migration; no MonetPlane demand yet).
- PayPal requires `webhookId` for signature verification — connections
  without it fail webhook verification closed (by design).
