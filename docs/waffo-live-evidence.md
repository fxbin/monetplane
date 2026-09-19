# Waffo Pancake Live Verification Evidence (#41 / #68)

Date: 2026-09-19 · Environment: local MonetPlane (dev server) + real Waffo
Pancake sandbox (test mode) + real merchant credentials + ngrok webhook
tunnel. Every step below ran against the LIVE Waffo platform — no mocks.

Connection: `pconn_9b455b00-7c28-4718-9b4b-18c4cd04abfd` (Waffo Pancake
Sandbox, merchant `MER_6wZlJqSPKpDzf5O8Zl738e`, store
`STO_6t1dd4owSfx0ge0SEVSqy4`, product routing on both test products).

## Journey evidence (all live)

| Step | Evidence |
|---|---|
| Connect real provider | Console connect form (`provider: waffo` → "Waffo Pancake", merchantId/privateKey/storeId); configuration diagnostic **passed**: "Merchant credentials verified with Waffo" (first real signed API call) |
| Products via console | `Pancake Pro` (one-time $29.00, entitlement `pancake_pro_access`) and `Pancake Monthly` (monthly $9.00, entitlement `pancake_monthly_access`), both routed to the Waffo connection through the Product Builder API |
| SDK routed checkout (no providerConnectionId) | Payment Router resolved `source: "product", provider: "waffo"`; real product shell + checkout session created in Waffo (`pancake.waffo.ai/store/xiaoyi-k5zw7dlq/checkout/cs_cb83c2d8…` and `cs_8d9e6634…`) |
| Real payment (one-time) | Waffo sandbox card form → **Payment Successful**, Waffo order `A202609190356319383757`, $29.00 VISA, 2026-09-19 11:58 |
| Real webhook ingestion | `order.completed` (delivery id `PAY_1XvDwEuMyO7NJaisJAhMom`) via ngrok → `/api/webhooks/<connectionId>` → signature verified (x-waffo-signature, built-in keys) → inbox **processed**; order `ord_7b386aab…` → **paid**; payment row succeeded $29.00; entitlement `pancake_pro_access` → **active** |
| Real subscription lifecycle | `Pancake Monthly` checkout → **Subscription successful**, Waffo order `A202609190404492213772`, $9.00/mo; webhooks `subscription.payment_succeeded` + `subscription.activated` both **processed**; subscription `ORD_1GLPE2VlXYXJXq2zoN3ynv` **active**, period end 2026-10-19, items snapshot 900/USD/month; entitlement `pancake_monthly_access` **active** |
| Console cancel | Admin cancel → real `orders.cancelSubscription` API call → operation **completed**; subscription `cancel_at_period_end: true` (Waffo end-of-period semantics); audit entry `subscription.cancelled` |
| Developer lifecycle events | Real signed deliveries (HMAC `v1=…`) to a console-configured endpoint: `payment.succeeded` (dev_wh_d3845742…) and `subscription.activated` (dev_wh_0b8e3ca9…), envelope v1, orderId-correlated |
| Operator audit | Audit log captured `provider.reconfigured`, `api_key.created` ×5, `webhook_endpoint.created`, `subscription.cancelled` with actor + environment; no secrets in metadata |
| Usage/credits checks | SDK `checkEntitlement` granted=true (verified earlier); `reportUsage` on undefined meter correctly fail-closed (`UsageMeterNotFoundError`) |

## Findings fixed during verification

1. **#95 / PR #96** — inbound receiver required a custom header providers
   never send; now resolves the application from the connection id
   (404 on unknown, 401 on bad signature — verified through the tunnel).
2. **#97 / PR #98** — Waffo refund capability declared **false** (the
   Pancake gateway denies merchant-issued session refund tickets with 403
   even for scope-valid tokens; SDK has no merchant refund API — refunds
   happen in the Waffo dashboard and flow back via `refund.succeeded/failed`
   webhooks, which stay mapped). Also: callback-origin errors now 400, and
   permanently-unprocessable verified events park with
   `200 {received, processed:false}` instead of a 24h provider retry storm.
3. Webhook retry behavior confirmed against the platform: Waffo retried a
   permanently-unmapped early test event (recorded failed, correctly not
   applied) before the park fix landed.

## Qualifications (honest limits)

- **Test mode only**: production (live charges, KYB-gated features) is not
  exercised; `prodEnabled=false` behavior (403 until KYB review) comes from
  Waffo docs, not live proof.
- **Refunds**: merchant-path tickets are denied by Waffo today (see #97);
  dashboard-initiated refund webhook flow (`refund.succeeded` mapping) is
  implemented and unit/contract-tested but not live-fired.
- **Key hygiene**: the merchant private key transited chat during setup —
  rotation recommended (Waffo console → new Merchant API Key → console
  Reconfigure), after which this document's credentials are historical.
- ngrok free tunnel URL is ephemeral; webhook URL must be updated in the
  Waffo console when the tunnel changes.

## Conclusion

The #68 real-product journey now has live-provider evidence end to end:
console-configured real provider → routed SDK checkout → real hosted
payment → signed webhook ingestion → durable billing effects → signed
developer events → operator actions with audit. Sandbox/test-mode scope,
with the explicit qualifications above.
