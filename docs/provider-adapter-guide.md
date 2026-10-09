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

### 4b. Catalog product lookup (optional, #155)

`getCatalogProduct(connection, { providerProductId })` is the optional
read-only lookup behind the console "link existing provider product"
flow. It fetches the provider-side product and normalizes it into
`NormalizedProviderCatalogProduct` (id, name, status, environment mode,
billing type, minor-unit amount, currency, recurring interval + count,
tax category). The link flow compares every field against the MonetPlane
price and fails closed on any mismatch or on any value the adapter cannot
represent (Creem, for example, rejects `every-day` billing periods because
MonetPlane prices cannot express them).

Rules for implementers:

- **Read-only.** This method must never mutate anything at the provider.
- **Fail closed.** Missing fields, unknown enum values, and non-integer
  minor-unit amounts throw instead of returning a best-effort shape.
- **Credentials stay server-side.** Use the decrypted connection
  credentials exactly like checkout does; the lookup result must never
  echo them.
- **Precedence contract.** Checkout items may carry a runtime-resolved
  `providerProductId` (from the persisted `provider_catalog_mappings`
  table); adapters must prefer it over their legacy
  `connection.metadata.catalog` lookup so existing connections keep
  working unchanged while new links take effect. A missing implementation
  means the provider cannot verify existing products, and linking fails
  closed with a rejected `ProviderOperationError`.

### 4c. Catalog product creation (optional, #156)

`createCatalogProduct(connection, input)` is the optional create behind the
console provisioning flow, gated by the `catalog_provisioning` capability
(declare it `false` in your capability record when unsupported). The
provisioning state machine calls it with a caller-stable
`idempotencyKey` (the persisted mapping row id) so a re-sent create after
a crash dedupes at the provider instead of forking duplicates — implement
the header/parameter only if the provider's documented contract supports
it (Creem: `Idempotency-Key`, verified 2026-10-08).

Rules for implementers:

- **Return only `{ providerProductId }`.** The caller re-reads the product
  through `getCatalogProduct` and compares it against the MonetPlane price
  before declaring the mapping synced (bidirectional verification). Do not
  trust the create response body beyond its id.
- **Pre-flight fail closed.** Provider-side constraints you know about
  (Creem: USD/EUR currencies, price 0 or ≥ 100 minor units, documented
  tax categories) are rejected as deterministic `ProviderOperationError`s
  BEFORE any HTTP call — deterministic rejections park the intent as
  `failed`; timeouts and 5xx park it as `needs_reconciliation`.
- **Map intervals honestly.** Prefer the provider's fixed billing periods
  when they match (month×1 → `every-month`, …); everything else MonetPlane
  can express goes through the provider's custom-interval form. An
  interval you cannot represent must throw, not round.
- **`ProviderOperationError` now carries `status?`** for HTTP failures —
  the orchestration uses it to distinguish bounded-retry 429 rate limits
  from other deterministic 4xx rejections.

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
  invokes an operation the connection's capabilities do not claim. You do not
  throw this yourself.

For plain HTTP failures, do not hand-classify: route them through
`classifyHttpFailure(status, message)` from the shared kit — any 4xx
is `rejected` (the request never executed server-side), 5xx and unknown
statuses stay `outcome_uncertain`. All three current adapters use it; a fourth
adapter that classifies differently will drift from operator retry semantics
(roundtable batch 1).

## Shared adapter kit (reuse, don't re-implement)

`src/modules/providers/adapters/shared.ts` provides the pieces adapters used to
copy-paste: JSON guards (`isRecord`, `stringValue`, `numberValue`,
`recordValue`, `headerValue`), `requiredCredential` (throws a classified
`ProviderOperationError(..., "rejected")` — missing credentials are
deterministic refusals, retry-safe after input fixes), `providerBaseUrl`,
`classifyHttpFailure`, and `providerFetchJson` (fetch with a 10s
`AbortSignal` timeout — provider calls must never hang indefinitely).
Currency/decimals handling comes from
`src/lib/money.ts` (`currencyDecimals`, `parseProviderAmountToMinor`) — never
keep a provider-local zero-decimal table: the divergent tables that predated
the unified registry produced provider-dependent 100x price errors.

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
