# PayPal Live Verification Evidence

Date: 2026-09-26 · Environment: real PayPal **sandbox** API
(`api-m.sandbox.paypal.com`) with real sandbox REST credentials owned by the
operator, plus the real sandbox buyer approval flow completed in a browser
(personal sandbox account), and real webhook delivery through a public
ngrok tunnel into a running MonetPlane dev server. Adapter: `src/modules/providers/adapters/paypal.ts` (PSP model —
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
| Cancel endpoint | `POST /v1/billing/subscriptions/{id}/cancel` — route+auth verified; PayPal returned "not cancellable" for `APPROVAL_PENDING` subscriptions (only `ACTIVE` is cancellable) |
| Webhook verification | Contract-tested against the `verify-webhook-signature` request shape; `webhookId` is a connection credential (console field added) |

## Buyer-approval journey (live, browser + API)

| Step | Evidence |
|---|---|
| One-time approval | Order `49L12542FE518390U` ($12.00) approved by the sandbox buyer (`sb-…@personal.example.com`) through the hosted checkout (`/checkoutnow` → login → 「完成购物」); redirected to `return_url?token=…&PayerID=X3BKGR6FG2CMQ` |
| Real capture | `POST /v2/checkout/orders/{id}/capture` → **201**, capture `7AV91188T0463123J` `COMPLETED` $12.00 — **`custom_id` echoed verbatim** (`monetplane_order_id:ord_buyer_evidence_1\|monetplane_customer_id:cus_buyer_evidence`), proving the webhook correlation contract end-to-end |
| Real refund | `POST /v2/payments/captures/{id}/refund` → **201**, refund `9R083634CD4158109` `COMPLETED`; capture status flipped to `REFUNDED` (matches the adapter's `mapPaymentStatus`) |
| Subscription first payment | Subscription `I-KCYB5XN8J1NX` approved through the hosted flow; first $19.00 charge executed (`billing_info.last_payment`) — PayPal's plan schema **defaults `total_cycles` to 1**, so the subscription then EXPIRED naturally (`failed_payments_count: 0`). Plans intended to auto-renew must set `total_cycles: 0` |
| Subscription ACTIVE | Auto-renew plan `P-4V955578YC8930518NK33FYQ` (`total_cycles: 0`) → subscription `I-MN88MMVNENFM` approved → **ACTIVE** with `next_billing_time` 2026-10-26 |
| Real cancel | `POST /v1/billing/subscriptions/{id}/cancel` → **204**; subscription status → **`CANCELLED`** |

## Webhook delivery journey (live, end-to-end through MonetPlane)

Setup: console-driven (bootstrapped owner → application → PayPal connection
with clientId/clientSecret → products/prices → connection
`catalog[priceId] = {productId, planId}` mapping → console API key → ngrok
tunnel → `POST /v1/notifications/webhooks` registering
`https://<tunnel>/api/webhooks/<connectionId>` for the CAPTURE/SALE/
BILLING.SUBSCRIPTION event families → real `WH-…` id written back into the
connection credentials via the console reconfigure API).

| Step | Evidence |
|---|---|
| Subscription via SDK | `POST /api/checkout` (mp_app_* bearer) → adapter created PayPal subscription `I-EHDPHD596XTR` for order `ord_133fb635…`; buyer approved in the hosted flow |
| 3 webhooks delivered | `BILLING.SUBSCRIPTION.CREATED` → `subscription.created`, `BILLING.SUBSCRIPTION.ACTIVATED` → `subscription.activated`, `PAYMENT.SALE.COMPLETED` → `subscription.renewed` — all **signature-verified via the verify-webhook-signature API** (~1s per delivery incl. verification round-trip) and marked **processed** in the webhook inbox |
| Control-plane state | subscriptions row `I-EHDPHD596XTR` → **active**, matching PayPal |
| Fail-closed probe | A POST to the webhook URL with an empty body → **401** (rejected before processing) |
| One-time via SDK | `POST /api/checkout` → PayPal order `1KN476418L4787713`; buyer approved; merchant capture `5TX960442V340890N` **201 COMPLETED** |
| Capture webhook | `PAYMENT.CAPTURE.COMPLETED` delivered through the tunnel → **processed** as `payment.succeeded`; order `ord_9f383552…` → **paid**; payments row `5TX960442V340890N` succeeded $12.00 |

## Capability mapping (post-verification)

`one_time_checkout`, `recurring_subscription`, `monthly_interval`,
`annual_interval`, `weekly_interval`, `trial_periods`,
`provider_hosted_checkout`, `subscription_cancel` (real ACTIVE → CANCELLED),
`refund` (real COMPLETED refund) — all verified by the live calls above.
`subscription_update` (`/revise`) and `customer_portal` — not supported by
this adapter v1.

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
- One-time capture is merchant-driven (`POST /v2/checkout/orders/{id}/capture`
  after buyer approval); PayPal has no auto-capture-on-approval for the
  redirect flow and the adapter does not perform captures inside webhook
  processing. `CHECKOUT.ORDER.APPROVED` events are normalized as `unknown`
  today.
- `subscription_update` intentionally unsupported (PayPal revise supports
  quantity/shipping and plan migration; no MonetPlane demand yet).
- PayPal requires `webhookId` for signature verification — connections
  without it fail webhook verification closed (verified live by the 401
  probe above).
- Operator gotcha worth restating: plans default `total_cycles` to 1 (the
  subscription expires after the first charge). Auto-renewing plans need
  `total_cycles: 0`.
