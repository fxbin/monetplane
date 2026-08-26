# P0 Acceptance Gate Evidence

This document maps every criterion from Issue #12 (`[P0 Gate] Security, idempotency, concurrency, and integration acceptance`) to concrete test evidence in the MonetPlane codebase.

Each criterion is backed by a runnable test that can be verified locally or in CI.

---

## Multi-application isolation

### Two applications share one deployment without leaking state

**Evidence:** `tests/integration/two-app-isolation.test.ts`

- `app-a (credits) and app-b (entitlements) share one SDK surface but never share state`
  - Creates two applications with different slugs and secrets.
  - App-A creates a customer and grants credits; App-B creates a customer and grants an entitlement.
  - Asserts that App-A's customer does not exist in App-B, App-B's entitlement is not visible in App-A, and App-A's credits are not spendable from App-B.
  - Cross-application customer IDs, credit balances, and entitlements are all isolated.

### Host-derived and credential-derived application context cannot be overridden

**Evidence:** `tests/integration/application-registry.test.ts`

- `fails closed when host and credential point at different applications`
  - Host resolves to App-A; credential belongs to App-B. Request is rejected with `ApplicationContextMismatchError`.
- `ignores caller-supplied application ids and trusts derived context`
  - Request includes `x-application-id` header pointing at a different app. The resolver ignores it and uses the host-derived context.

---

## Payment correctness

### Browser redirects cannot activate paid state

**Evidence:** `tests/integration/commerce-webhooks.test.ts`

- `derives amount/catalog context server-side and keeps redirect state pending`
  - After `createCommerceCheckout`, the order status is `pending` and the checkout session is `open`. No paid state is activated until a signed webhook arrives.

### Invalid webhook signatures have zero business effects

**Evidence:** `tests/integration/commerce-webhooks.test.ts`

- `rejects invalid signatures before creating an inbox row`
  - An invalid signature causes `InvalidProviderWebhookSignatureError` before any database row is written. Zero `webhookEvents` rows exist after the attempt.

### Duplicate/replayed valid webhooks apply each commercial effect once

**Evidence:** `tests/integration/commerce-webhooks.test.ts`

- `marks one-time orders paid only from a signed payment webhook and deduplicates concurrent replay`
  - Two concurrent webhook deliveries with the same event ID result in exactly one `payment` row, one `webhookEvents` row (status `processed`), and exactly one of the two responses is marked `duplicate: true`.

### Failed renewals do not grant new entitlement periods or recurring credits

**Evidence:**

- `tests/integration/entitlements.test.ts`
  - `creates one time-bounded grant per paid subscription period and no grant for failed renewal`
    - After `subscription.activated`, one entitlement grant exists.
    - After `payment.failed` (renewal failure), the grant count remains 1 — no new grant is created.
    - After `subscription.renewed` (recovery), a second grant is created for the new period.
    - Replayed `subscription.renewed` does not create a third grant.

- `tests/integration/credits-commerce.test.ts`
  - `grants each paid subscription period once and never grants a failed renewal`
    - After `subscription.activated`, balance is 30.
    - After `payment.failed`, balance remains 30 — no credits granted.
    - After `subscription.renewed` (replayed twice), balance is 60 — only one additional grant.
    - `subscription.updated` with the same period does not grant again.

---

## Credit correctness

### Concurrent debit stress test never creates a negative balance

**Evidence:** `tests/integration/credits-ledger.test.ts`

- `allows only the funded subset of 100 concurrent debits and never goes negative`
  - Seeds 50 credits, fires 100 concurrent 1-credit debits.
  - Exactly 50 succeed, 50 fail with `InsufficientCreditsError`.
  - Final balance is 0, and every transaction's `availableAfter >= 0`.

### Idempotent debit/reserve/capture/release semantics pass retry tests

**Evidence:** `tests/integration/credits-ledger.test.ts`

- `serializes repeated idempotency keys so a debit and reserve apply once`
  - 8 concurrent debits with the same key: only 1 is non-duplicate; balance reflects a single charge.
  - Repeated reserve with the same key: second call returns `duplicate: true` and the same reservation ID.

- `keeps reserved credits unavailable, partially captures, and releases exactly once`
  - Capture replay returns `duplicate: true`; balance unchanged on replay.
  - Release replay returns `duplicate: true`; balance unchanged on replay.

### Capture/release race ends in one legal terminal reservation state

**Evidence:** `tests/integration/credits-ledger.test.ts`

- `serializes capture/release races into one terminal reservation state`
  - Concurrent capture and release on the same reservation: exactly one succeeds, one is rejected.
  - The reservation ends in either `captured` or `released` state.
  - `reserved` balance is 0 after the race.

### Ledger insertion failure rolls back balance changes

**Evidence:** `tests/integration/credits-ledger-rollback.test.ts`

- `rolls back balance changes when ledger insertion fails`
  - A proxy Database intercepts `insert(creditTransactions)` and throws to simulate a ledger failure.
  - The debit is rejected; the balance remains unchanged at 100.
  - No transaction row exists for the failed debit's idempotency key.

---

## Secrets/security

### Application/provider secrets are not exposed to browsers or logs

**Evidence:**

- `tests/integration/application-registry.test.ts`
  - `stores only credential hashes and authenticates the one-time secret`
    - The issued `secret` starts with `mp_app_`; the stored `secretHash` is not the secret itself.

- `tests/provider-crypto.test.ts`
  - `round-trips credentials without embedding plaintext`
    - Encrypted credential output does not contain plaintext `apiKey` or `webhookSecret`.

### Provider credentials are encrypted at rest

**Evidence:** `tests/provider-crypto.test.ts`

- `round-trips credentials without embedding plaintext`
  - `encryptProviderCredentials` produces a `v1:` prefixed ciphertext.
  - `decryptProviderCredentials` restores the original values.
- `rejects tampered ciphertext`
  - Modifying any part of the ciphertext causes decryption to throw.

### Open redirect attempts through checkout callback URLs are rejected

**Evidence:**

- `tests/integration/application-registry.test.ts`
  - `allows only registered callback origins`
    - Unregistered origin `https://attacker.test/redirect` is rejected with "not allowed".

- `tests/integration/commerce-webhooks.test.ts`
  - `rejects open redirect attempts through unregistered callback URLs`
    - Checkout with `successUrl: "https://attacker.test/phish"` is rejected.
    - Checkout with `cancelUrl: "https://evil.test/steal"` is rejected.

---

## Provider independence

### Shared provider contract tests pass for Mock and Creem

**Evidence:**

- `tests/mock-provider.test.ts` — Mock adapter passes the full `defineProviderAdapterContractTests` suite.
- `tests/provider-contract/creem-adapter.test.ts` — Creem adapter passes the same contract suite.

### Waffo passes claimed-capability contract tests

**Evidence:** `tests/provider-contract/waffo-adapter.test.ts`

- Waffo adapter passes the shared `defineProviderAdapterContractTests` suite.
- Real Waffo API access is not available in CI. Waffo's production multi-provider support is documented but not claimed as CI-verified. See `docs/waffo-provider.md` for scope details.

---

## Developer experience

### Fresh-install commands are verified

**Evidence:** `README.md` documents the following commands, all verified in CI:

```bash
npm run lint
npm run typecheck
npm test
npm run db:migrate
npm run build
```

CI provisions a fresh PostgreSQL database, applies migrations twice, then starts the production build and verifies `GET /api/health`.

### Two example applications complete the documented integration path

**Evidence:** `tests/integration/two-app-isolation.test.ts`

- App-A (AI Photo Generator, credit-based) and App-B (SaaS Billing Demo, entitlement-based) both use the same SDK surface (`createMonetPlaneClient`) with their own `appSecret`.
- Both complete the full lifecycle: `upsertCustomer` → `createCheckout` → webhook processing → `getCreditBalance` / `checkEntitlement`.

### README and durable architecture docs match implemented behavior

**Evidence:**

- `README.md` — describes the P0 outcome and development commands.
- `docs/architecture.md` — describes the modular monolith deployment model.
- `docs/provider-contract.md` — describes the provider adapter contract and webhook processing order.
- `docs/credits-ledger.md` — describes the credit ledger model and failure cases.
- `docs/sdk-quickstart.md` — describes the Server SDK integration path.
- `docs/waffo-provider.md` — describes the Waffo adapter scope and capability matrix.

---

## Exit rule

Every applicable P0 criterion listed above is backed by fresh CI/runtime evidence from runnable tests. The only external-provider evidence that is not CI-verified is real Waffo API access, which is explicitly marked as a scope limitation in `docs/waffo-provider.md` rather than inferred from mocks.
