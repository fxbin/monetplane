# Waffo Provider Adapter (Pancake MoR)

This document records MonetPlane's Waffo adapter boundary. Protocol source
of truth: the official **`@waffo/pancake-ts`** SDK against the Waffo
Pancake MoR platform (docs.waffo.ai). The previous `@waffo/waffo-node`
PSP contract is retired — Waffo's current platform is Pancake, and the
two API surfaces are incompatible.

## What the SDK owns

- Merchant API Key request signing (RSA-SHA256 with the merchant private key)
- Webhook signature verification: `x-waffo-signature` header
  (`t=<timestamp>,v1=<base64>` over `${t}.${rawBody}`) verified with
  **built-in per-environment platform public keys** and anti-replay
  tolerance (default 45 min to cover Waffo's full retry schedule)
- API hosts and idempotency (deterministic keys derived from
  merchant + path + body — retries are safe)
- `WaffoPancakeError` (`status`, `errors[]`) semantics

## Connection configuration

| Field | Purpose |
| --- | --- |
| `merchantId` | `MER_…` merchant id sent as `X-Merchant-Id`. The gateway derives the environment (test/prod) from the API key itself. |
| `privateKey` | Merchant RSA private key (PEM or base64 PKCS8) from the Waffo console's Merchant API Key. Signs every request. |
| `storeId` | `STO_…` store that owns the product shells MonetPlane creates. |

The previous `apiKey` / `waffoPublicKey` / `notifyUrl` contract is
obsolete. Existing connections created with that legacy shape must use
**Reconfigure → Replace connection config** before Waffo runtime
operations are considered valid.

## Checkout model

Pancake checkout sessions reference exactly **one product**; multi-item
MonetPlane checkouts fail closed with `UnsupportedProviderCapabilityError`
on the Waffo route. For each checkout MonetPlane creates an idempotent
"shell" product (deterministic name + price → the SDK's idempotency
returns the same product for the same parameters) and then a checkout
session with:

- Shell-product pricing in display-value strings; MonetPlane converts
  minor units ↔ display with zero-decimal currency support
- `orderMerchantExternalId = monetplaneOrderId` — inherited by orders,
  payments, and refunds; the primary webhook correlation key
- Flat `metadata` with the MonetPlane customer id
- `withTrial` when the price carries a trial window (pricing v2)
- `buyerEmail`, `successUrl` passthrough

Refund/cancellation semantics: Waffo webhooks target a URL configured in
the Waffo console (`/api/webhooks/<connectionId>`); refunds are
**asynchronous tickets** submitted through a short-lived customer session
(`auth.issueSessionToken` → `customer.createRefundTicket`); completion
arrives as `refund.succeeded` / `refund.failed` webhooks. Subscription
cancellation uses `orders.cancelSubscription({ orderId })`.

## Failure semantics

Provider mutations participate in the billing-operation journal:

- `WaffoPancakeError` with HTTP 4xx → `rejected` (deterministic; operator
  may retry explicitly after fixing input/configuration)
- HTTP 5xx, network, or unknown-status failures → `outcome_uncertain`
  (never blindly retried; operator reconciles via webhooks/journal)
- Invalid local credentials/signing setup → deterministic local rejection

## Event mapping (webhook normalization)

| Pancake event | MonetPlane normalized type |
| --- | --- |
| `order.completed` | `payment.succeeded` |
| `subscription.payment_succeeded` | `payment.succeeded` (subscription order id attached) |
| `subscription.activated` | `subscription.activated` |
| `subscription.renewed` | `subscription.renewed` |
| `subscription.recovered` | `subscription.updated` (active) |
| `subscription.plan_changed` / `plan_change_scheduled` / `plan_change_failed` | `subscription.updated` |
| `subscription.canceling` | `subscription.updated` (cancelAtPeriodEnd) |
| `subscription.uncanceled` | `subscription.updated` (active) |
| `subscription.past_due` | `subscription.updated` (past_due) |
| `subscription.canceled` | `subscription.cancelled` |
| `refund.succeeded` | `payment.refunded` |
| `refund.failed` | `unknown` (visible in the Events timeline; no billing-state mutation) |

Delivery identity: the envelope `id` (UUID) is the idempotency key —
Waffo retries (5m/30m/2h/8h/24h ×5) can never double-apply.

## Capabilities

`one_time_checkout`, `recurring_subscription` (weekly / monthly /
yearly), `trial_periods`, `refund` (async tickets), `subscription_cancel`,
`provider_hosted_checkout` are declared. `subscription_update` and
`customer_portal` stay **false** — Pancake plan changes happen in the
Waffo dashboard or via product groups, and there is no hosted portal to
link to.
