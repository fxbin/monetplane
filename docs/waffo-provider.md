# Waffo Provider Adapter

This document records the current MonetPlane interpretation of the Waffo adapter boundary for P0.

## Scope

The adapter is provider-neutral from MonetPlane's core perspective. Waffo-specific objects, statuses, request fields, and webhook payloads must stay inside `src/modules/providers/adapters/waffo.ts` and tests.

## API model

The adapter uses Waffo's manual API integration model:

- Sandbox base URL: `https://api-sandbox.waffo.com`
- Production base URL: `https://api.waffo.com`
- Request format: JSON POST
- Required headers: `X-API-KEY`, `X-SIGNATURE`

Implemented endpoint mappings:

| MonetPlane operation | Waffo endpoint |
| --- | --- |
| Create one-time checkout | `POST /api/v1/order/create` |
| Query payment | `POST /api/v1/order/inquiry` |
| Refund payment | `POST /api/v1/order/refund` |
| Create subscription checkout | `POST /api/v1/subscription/create` |
| Query subscription | `POST /api/v1/subscription/inquiry` |
| Cancel subscription | `POST /api/v1/subscription/cancel` |
| Change subscription | `POST /api/v1/subscription/change` |

## Capability matrix

| Capability | Declared | Notes |
| --- | --- | --- |
| one_time_checkout | yes | Maps to order create. |
| recurring_subscription | yes | Maps to subscription create. |
| monthly_interval | yes | Supported through Waffo subscription products/configuration. |
| annual_interval | yes | Supported through Waffo subscription products/configuration. |
| refund | yes | Maps to order refund. |
| subscription_cancel | yes | Maps to subscription cancel. |
| subscription_update | yes | Maps to subscription change. |
| customer_portal | no | MonetPlane does not expose a provider-neutral customer portal method yet. |
| provider_hosted_checkout | yes | Waffo returns a hosted checkout/action URL. |

## Webhook normalization

Supported Waffo notification types:

| Waffo event type | MonetPlane normalized event |
| --- | --- |
| `PAYMENT_NOTIFICATION` with success status | `payment.succeeded` |
| `PAYMENT_NOTIFICATION` with non-success terminal status | `payment.failed` |
| `REFUND_NOTIFICATION` | `payment.refunded` |
| `SUBSCRIPTION_STATUS_NOTIFICATION` active | `subscription.activated` |
| `SUBSCRIPTION_STATUS_NOTIFICATION` cancelled | `subscription.cancelled` |
| `SUBSCRIPTION_STATUS_NOTIFICATION` expired / closed | `subscription.expired` |
| `SUBSCRIPTION_STATUS_NOTIFICATION` other status | `subscription.updated` |
| `SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION` | `subscription.renewed` |
| `SUBSCRIPTION_CHANGE_NOTIFICATION` | `subscription.updated` |
| unrecognized events | `unknown` |

## Verification status

Current branch coverage:

- Provider contract tests for Waffo capability declaration.
- Provider contract tests for checkout normalization.
- Provider contract tests for webhook signature rejection before normalization.
- Provider contract tests for stable provider event identity and normalized event type.

Still required before closing #10:

- Fresh local validation against current `main`.
- Sandbox/test-mode evidence when Waffo credentials/test access are available.
- Explicitly record any API capability gaps discovered during sandbox testing.
