# Payment Provider Adapter Author Guide

How to add a new payment provider to MonetPlane by implementing the adapter
contract — without touching core domains and without studying existing
adapter internals. The normative type surface lives in
[`src/modules/providers/contract.ts`](../src/modules/providers/contract.ts);
the background contract rationale is in
[`docs/provider-contract.md`](provider-contract.md).

A new provider is a **leaf**: it must integrate through the extension points
below with zero provider-specific branching in the commerce, credits, or
entitlements core. This is enforced by [`tests/module-boundaries.test.ts`](../tests/module-boundaries.test.ts).

## The four touchpoints

| # | File | What you do |
|---|------|-------------|
| 1 | `src/modules/providers/adapters/<provider>.ts` | Implement `PaymentProviderAdapter` |
| 2 | `src/modules/providers/runtime.ts` | Add your factory to `resolveProviderAdapter`'s lazy-instantiation chain |
| 3 | `src/modules/providers/setup.ts` | Add a `SUPPORTED_PROVIDER_SETUPS` entry (console connect-form fields + validation) |
| 4 | `tests/provider-contract/<provider>-adapter.test.ts` | Bind your adapter to the shared conformance suite |

Nothing else. If you find yourself wanting to edit `src/modules/commerce`,
`src/modules/credits`, or `src/modules/entitlements` for your provider, the
abstraction is missing something — extend the *contract* instead (see
"Changing the contract" below), never the core.

## Adapter lifecycle, step by step

### 1. Configuration schema and setup metadata

`SUPPORTED_PROVIDER_SETUPS` drives the console connect form: every credential
field your provider needs is declared there with a label and validation. The
console never sees provider runtime behavior through this file — it is setup
metadata only. Credentials entered through the form are AES-GCM encrypted at
rest (`providers/crypto.ts`), stored as `encrypted_credentials` on the
connection row, and are **write-only**: they are decrypted into the adapter's
`ProviderConnectionContext` at call time and are never returned by any API
after creation.

Declare only what your provider genuinely needs. If a field is a secret,
name it like one — audit-log metadata is deep-redacted for keys matching
`/secret|credential|password|token|api[-_]?key|private[-_]?key|signing/i`.

### 2. Capabilities — honest, explicit, boolean

`getCapabilities(connection)` returns an explicit boolean for every
capability in `PROVIDER_CAPABILITIES`. The rules:

- Claim a capability **only** if you have verified it against the provider's
  real API (sandbox evidence at minimum). "The docs say it exists" is not
  verification — see [`creem-live-evidence.md`](creem-live-evidence.md) and
  [`waffo-live-evidence.md`](waffo-live-evidence.md) for the expected
  evidence format.
- If you have not verified it yet, ship `false` and leave a `TODO(verify)`
  comment naming the blocker. A `false` capability makes the core reject the
  operation before any provider call; a lying `true` produces broken
  customer-facing flows.
- If the provider adds a new behavior MonetPlane has no capability for, add
  the capability to the contract (see "Changing the contract"), default it to
  `false` for existing adapters, then claim it per the rules above.

### 3. Checkout

`createCheckout(connection, input)` receives a normalized input (order id,
customer linkage, billing mode, interval, trial window, currency, priced
items, success/cancel URLs, correlation metadata) and must return a
normalized `CheckoutResult`:

- `providerCheckoutId` — the provider's checkout/session id (persisted for
  reconciliation).
- `checkoutUrl` — the hosted URL the customer is redirected to. MonetPlane
  never handles raw card data; if your provider only supports card fields,
  it does not belong here.
- `reconciliationMetadata` — **must** include `monetplane_order_id` and
  `monetplane_customer_id`; they are the webhook correlation keys.

### 4. Mutations (payments, subscriptions, refunds)

`getPayment`, `getSubscription`, `cancelSubscription`, `updateSubscription`,
and `refundPayment` translate provider responses into the normalized types.
The normalized status enums are closed (`payments: pending | succeeded |
failed | refunded`; `subscriptions: pending | active | past_due |
cancelled | expired`) — map provider states onto them; never extend them
per provider. Return only the fields in the normalized types; the conformance
suite rejects raw provider payloads leaking through.

For the optional hosted payment-management redirect
(`createCustomerPortalSession`, capability `customer_portal`): implement it
only if the provider offers a real hosted billing portal, return only the
provider-produced URL, and remember the customer portal never invents URLs
from browser input.

### 5. Webhook verification and normalization

`verifyWebhook` authenticates the raw request (signature/HMAC) and throws
`InvalidProviderWebhookSignatureError` on any mismatch — verification happens
**before** parsing or normalization, and unknown/unsigned events are rejected,
not parked. `normalizeWebhook` maps the verified payload onto
`NormalizedProviderEvent`:

- `providerEventId` must be stable (the webhook inbox deduplicates on it).
- `type` must be one of `NORMALIZED_PROVIDER_EVENT_TYPES`; events that do not
  map become `"unknown"` (they are stored and visible, but do not drive
  billing state).
- Stamp `providerConnectionId` and `applicationId` from the connection, not
  from the payload.
- Preserve `monetplaneOrderId` / `monetplaneCustomerId` when the provider
  echoes the correlation metadata from checkout.

Webhooks are the source of truth: inbound events (`/api/webhooks/[connectionId]`,
routed by connection id) drive all durable billing state. Your adapter never
writes MonetPlane state directly.

### 6. Diagnostics and error classification

Adapters do not implement diagnostics themselves — the console derives
connection diagnostics from capabilities and provider metadata. What you must
get right is **failure classification**:

- `ProviderOperationError(message, "rejected")` — the provider deterministically
  refused the request (bad credentials, validation, unsupported input).
  These are safe to retry *after* fixing input, via the explicit retry
  action in the billing-operations journal.
- `ProviderOperationError(message, "outcome_uncertain")` — timeout, network
  failure, ambiguous response. These are **never** auto-retried; they park
  the operation as `needs_reconciliation`. When unsure which kind applies,
  use `outcome_uncertain` — fail-safe beats fail-fast with money.
- `UnsupportedProviderCapabilityError` — thrown by the runtime when a caller
  invokes an operation the connection's capabilities do not claim. You do
  not throw this yourself.

## Testing your adapter

### Shared conformance suite (required)

Bind your adapter to `tests/provider-contract/adapter-contract.ts` — see
`creem-adapter.test.ts` for the binding shape. You provide a
`ProviderConnectionContext`, a `CreateCheckoutInput`, valid/invalid webhook
fixtures (use a fake `fetch` — no network), and the expected normalized event.
The suite enforces:

- explicit boolean capability shape,
- normalized checkout with correlation metadata and **no raw provider
  payloads** leaking,
- signature rejection before normalization,
- stable, typed event identity with connection/application stamping.

```ts
defineProviderAdapterContractTests({
  name: "myprovider",
  adapter: myProviderAdapter,
  connection: { /* test connection context with fake credentials */ },
  checkout: { /* normalized checkout input */ },
  validWebhook: { rawBody, headers: { "x-signature": sig } },
  invalidWebhook: { rawBody, headers: { "x-signature": "deadbeef" } },
  expectedEventId: "evt_1",
  expectedEventType: "payment.succeeded",
});
```

### Boundary tests (required, no work needed)

`tests/module-boundaries.test.ts` automatically keeps adapters from importing
commerce/credits/entitlements and keeps core domains free of provider names.
Run it; do not weaken it.

### Local run

```bash
pnpm test                # unit + contract suites (no network, no database)
pnpm test:integration    # needs DATABASE_URL; covers runtime/registry/connections
pnpm lint && pnpm typecheck
```

## Real-world verification

Before a provider is offered as generally usable, record live sandbox
evidence in `docs/<provider>-live-evidence.md` following the existing
evidence docs: what endpoints were exercised, with what sandbox credentials
(redacted), what succeeded/failed, and the date. Capabilities stay
unclaimed until this exists. If provider access is blocked (account
approval, region, credentials), the adapter may still land with capabilities
`false` and the external blocker documented — the claim comes later, never
sooner.

## Adapter author checklist

- [ ] Adapter file added under `src/modules/providers/adapters/<provider>.ts`, exporting a `create*ProviderAdapter()` factory
- [ ] Registered in `runtime.ts` `resolveProviderAdapter`
- [ ] `SUPPORTED_PROVIDER_SETUPS` entry with every credential field declared and validated
- [ ] Every `PROVIDER_CAPABILITIES` key present and boolean; only verified capabilities are `true`
- [ ] `createCheckout` returns correlation metadata (`monetplane_order_id`, `monetplane_customer_id`) and no raw payloads
- [ ] All normalized mappings use the closed status enums; no provider fields leak into normalized results
- [ ] `verifyWebhook` rejects invalid signatures before normalization; unmappable events normalize to `"unknown"`
- [ ] Failure classification: `rejected` vs `outcome_uncertain` chosen fail-safe
- [ ] Bound to `defineProviderAdapterContractTests` in `tests/provider-contract/<provider>-adapter.test.ts`
- [ ] `pnpm test`, `pnpm lint`, `pnpm typecheck` green; boundary tests untouched
- [ ] Live sandbox evidence recorded (or capability left `false` with the blocker documented)

## Changing the contract

The contract evolves through an issue (issue-first, per #58) — a PR that
adds a contract member must update this guide, default the new member for
existing adapters, and extend the conformance suite so the next adapter gets
the new check for free.
