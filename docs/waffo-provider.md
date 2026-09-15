# Waffo Provider Adapter

This document records MonetPlane's current Waffo adapter boundary.

## Contract source

The P1 provider-console migration uses the official `@waffo/waffo-node` SDK (`3.1.0`) as the protocol source of truth rather than maintaining a parallel hand-written signing implementation.

The SDK owns:

- Sandbox / Production API hosts
- RSA-SHA256 request signing
- Waffo response-signature verification
- Waffo webhook-signature verification
- network / unknown-status error semantics

MonetPlane keeps Waffo-specific request objects, response objects, statuses, and webhook payloads inside `src/modules/providers/adapters/waffo.ts`.

## Connection configuration

A Waffo connection now requires:

| Field | Purpose |
| --- | --- |
| `apiKey` | Waffo API authentication. |
| `merchantId` | Merchant identity used by merchant-scoped requests. |
| `privateKey` | Merchant RSA private key, accepted by the SDK as Base64 PKCS8 DER or unencrypted PKCS8 PEM. |
| `waffoPublicKey` | Waffo RSA public key used to verify responses and webhooks. |
| `notifyUrl` | Public HTTPS webhook notification URL supplied to checkout/subscription creation. |

The previous `signingSecret` / `webhookSecret` HMAC contract is obsolete. Existing connections created with that legacy shape must use **Reconfigure → Replace connection config** before Waffo runtime operations are considered valid.

All connection values continue to live inside MonetPlane's encrypted provider-connection envelope and are write-only from the console.

## Failure semantics

Provider mutations participate in the P1 billing-operation journal.

- An explicit Waffo non-success response is classified as `rejected`. An operator may correct configuration/input and use MonetPlane's explicit retry attempt flow.
- `WaffoUnknownStatusError` is classified as `outcome_uncertain`. It must **not** be blindly retried because Waffo documents that the merchant must inquire the actual order/subscription state.
- Response-verification / unexpected SDK failures on a mutation are treated conservatively as uncertain when the provider may already have executed the request.
- Invalid local signing/private-key/serialization setup is a deterministic local rejection.

This distinction is what protects refund/cancel operations from accidental duplicate provider mutation.

## Implemented mappings

The adapter uses official SDK resources rather than constructing endpoint URLs directly:

| MonetPlane operation | Official SDK resource |
| --- | --- |
| Create one-time checkout | `waffo.order().create()` |
| Query payment | `waffo.order().inquiry()` |
| Refund payment | `waffo.order().refund()` |
| Create subscription checkout | `waffo.subscription().create()` |
| Query subscription | `waffo.subscription().inquiry()` |
| Cancel subscription | `waffo.subscription().cancel()` |
| Configuration diagnostic | `waffo.merchantConfig().inquiry()` |
| Verify webhook | `waffo.webhook().verifySignature()` |

Full refunds send the current Waffo contract fields including `refundRequestId`, `acquiringOrderId`, `merchantId`, decimal-string `refundAmount`, `refundReason`, and `requestedAt`. Subscription cancellation explicitly sends `subscriptionId`, `merchantId`, and `requestedAt`.

## Capability matrix

| Capability | Declared | Notes |
| --- | --- | --- |
| one_time_checkout | yes | Official order create resource. |
| recurring_subscription | yes | Official subscription create resource. |
| monthly_interval | yes | Encoded as monthly period interval 1. |
| annual_interval | yes | Encoded as monthly period interval 12. |
| refund | yes | Full refund only in current MonetPlane operations model. |
| subscription_cancel | yes | Immediate cancellation in current normalized model. |
| subscription_update | **no** | MonetPlane's current provider-neutral update input does not carry the full amount/product-period contract required by Waffo. |
| customer_portal | no | No provider-neutral portal method yet. |
| provider_hosted_checkout | yes | Waffo action response resolves to a hosted URL. |

The capability declaration deliberately fails closed instead of emulating an incomplete subscription-change operation.

## Webhook normalization

Webhook signatures are verified with the configured Waffo RSA public key before normalization.

Supported Waffo notification types:

| Waffo event type | MonetPlane normalized event |
| --- | --- |
| `PAYMENT_NOTIFICATION` + `PAY_SUCCESS` | `payment.succeeded` |
| `PAYMENT_NOTIFICATION` + known failed terminal state | `payment.failed` |
| non-terminal payment notification | `unknown` (audited, no billing mutation) |
| `REFUND_NOTIFICATION` + `ORDER_FULLY_REFUNDED` | `payment.refunded` |
| partial/in-progress/failed refund notification | `unknown` (prevents accidental full-refund reconciliation) |
| `SUBSCRIPTION_STATUS_NOTIFICATION` active | `subscription.activated` |
| `SUBSCRIPTION_STATUS_NOTIFICATION` cancelled | `subscription.cancelled` |
| `SUBSCRIPTION_STATUS_NOTIFICATION` expired / closed | `subscription.expired` |
| `SUBSCRIPTION_STATUS_NOTIFICATION` other status | `subscription.updated` |
| `SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION` | `subscription.renewed` |
| `SUBSCRIPTION_CHANGE_NOTIFICATION` | `subscription.updated` |
| unrecognized events | `unknown` |

When Waffo does not supply an explicit event ID, MonetPlane derives a deterministic identity from the event type plus the signed raw-body hash, so exact webhook replays remain idempotent without conflating distinct lifecycle payloads.

## Diagnostics and verification

The Provider Console configuration diagnostic performs a **read-only merchant configuration inquiry** for Waffo. This validates the actual API key / merchant ID / RSA signing / response-verification path rather than merely checking that strings exist in encrypted storage.

Automated coverage must prove:

- official SDK checkout boundary produces normalized checkout output;
- RSA webhook verification is invoked before normalization;
- refund/cancel payloads contain all required contract fields;
- explicit provider rejection maps to `rejected`;
- transport/unknown outcome maps conservatively to `outcome_uncertain`;
- Waffo setup rejects the obsolete HMAC credential shape;
- configuration diagnostics remain read-only.

Real Waffo Sandbox evidence for refund and cancellation is still required before #41 is considered complete. Mock/fixture coverage is not production evidence.
