# Payment Provider Adapter Contract

MonetPlane must keep payment-provider behavior outside the core domain. Provider adapters translate provider-specific requests/events into a stable MonetPlane contract.

## Goals

- Support different payment providers per application.
- Keep checkout/subscription business logic provider-agnostic.
- Normalize webhooks into stable domain events.
- Make provider capabilities explicit instead of pretending every provider behaves the same.
- Preserve provider object IDs for reconciliation and support.

## Provider connection

Each application may have one or more provider connections.

```text
ProviderConnection
- id
- application_id
- provider                 // creem | waffo | ...
- mode                     // test | live
- status
- encrypted_credentials
- webhook_secret/encrypted config
- metadata
```

Provider secrets must be encrypted at rest and never returned after creation.

## Capability model

Adapters expose capabilities so the core can reject unsupported operations before calling the provider.

```text
one_time_checkout
recurring_subscription
monthly_interval
annual_interval
refund
subscription_cancel
subscription_update
customer_portal
provider_hosted_checkout
```

P0 must not implement silent fallbacks for unsupported capabilities.

## Logical interface

The exact TypeScript interface may evolve, but P0 must preserve these semantic operations:

```ts
interface PaymentProviderAdapter {
  provider: string;

  getCapabilities(connection: ProviderConnection): ProviderCapabilities;

  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;

  getPayment(input: GetPaymentInput): Promise<NormalizedPayment>;

  getSubscription(input: GetSubscriptionInput): Promise<NormalizedSubscription>;

  cancelSubscription(input: CancelSubscriptionInput): Promise<NormalizedSubscription>;

  refundPayment(input: RefundPaymentInput): Promise<NormalizedRefund>;

  verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhook>;

  normalizeWebhook(input: VerifiedWebhook): Promise<NormalizedProviderEvent>;
}
```

Provider SDK response objects must not leak into core commerce, entitlement, or credit modules.

## Checkout input

The core gives an adapter provider-neutral data:

```text
application/customer context
order id
price/items
currency
billing mode
success URL
cancel URL
provider connection
metadata/correlation ids
```

The adapter returns:

```text
provider checkout/session id
checkout URL
provider customer id when available
provider metadata needed for reconciliation
```

## Normalized provider events

Webhook normalization produces a small stable vocabulary, for example:

```text
payment.succeeded
payment.failed
payment.refunded
subscription.created
subscription.activated
subscription.renewed
subscription.updated
subscription.cancelled
subscription.expired
```

Each normalized event includes:

```text
provider
provider_connection_id
provider_event_id
application_id
occurred_at
provider_customer_id
provider_payment_id?
provider_subscription_id?
monetplane_order_id?
monetplane_customer_id?
amount_minor?
currency?
raw_event_reference
```

Unknown provider events are persisted for audit but must not mutate commerce state until an explicit mapping exists.

## Webhook contract

Webhook processing order:

1. Resolve the provider connection from the webhook route/identifier.
2. Verify provider signature against the raw request body.
3. Create the webhook inbox row using a unique provider event ID.
4. If duplicate, return success without re-applying effects.
5. Normalize the event.
6. Apply commerce state transition in an idempotent transaction.
7. Apply entitlement/credit effects keyed to the normalized commercial event.
8. Mark the inbox event processed or failed with diagnostic metadata.

The browser redirect path is never allowed to substitute for this flow.

## Provider-specific logic boundary

Allowed inside adapters:

- request authentication
- provider SDK/API calls
- provider request field mappings
- signature verification
- provider event-name mapping
- provider status mapping
- provider-specific quirks required for API compatibility

Not allowed inside adapters:

- deciding product entitlements
- deciding credit grants
- updating application business data
- directly changing MonetPlane ledger balances
- bypassing core order/subscription state machines

## Initial adapters

P0 targets:

1. **Creem** — first end-to-end implementation target.
2. **Waffo** — second real-provider target to validate the abstraction.
3. **Mock provider** — deterministic local/test adapter used for contract tests and CI; it does not count as proof of real-world provider independence by itself.

## Contract tests

Every provider adapter must pass the same behavioral suite for capabilities it claims:

- creates a checkout with MonetPlane correlation metadata
- rejects unsupported billing modes
- verifies valid webhooks and rejects invalid signatures
- normalizes duplicate events to the same provider event identity
- maps payment success/failure/refund states
- maps subscription lifecycle states when supported
- never emits raw provider-specific objects into core-domain outputs

P0 provider independence is accepted only after the shared contract suite passes and at least one real sandbox flow completes end-to-end. A second real adapter is required before MonetPlane claims multi-provider production support.
