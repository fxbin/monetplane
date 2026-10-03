# MonetPlane P0 Architecture

> Environment isolation: see [adr-environment-isolation.md](./adr-environment-isolation.md)
> (decision for #49, implemented by #74). Console layering:
> [p1-console-architecture.md](./p1-console-architecture.md).

## 1. Product boundary

MonetPlane is a **multi-application monetization control plane**. It centralizes payment orchestration, subscriptions, entitlements, credits, and provider integrations while leaving authentication and product-specific data inside each application.

The P0 reference implementation is intentionally a **modular monolith**: one codebase, one deployment, one PostgreSQL database, and strict module boundaries.

## 2. Deployment model

```text
                 ┌──────────────────────────────┐
                 │      MonetPlane service      │
                 │  one codebase / deployment  │
                 └──────────────┬───────────────┘
                                │
                    Host → Application resolver
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
billing.product-a.com  billing.product-b.com  billing.product-n.com
          │                     │                     │
      Product A             Product B             Product N
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                │
                        MonetPlane modules
                                │
           ┌────────────────────┼─────────────────────┐
           │                    │                     │
      PostgreSQL          Provider adapters      Hosted pages/API
                               │
                  ┌──────┬────────┼────────┐
                  │      │        │        │
                Creem  Waffo   PayPal   mock (tests only)
```

A custom host does **not** imply a separate deployment. The host is resolved to an `Application` and that application context drives branding, catalog, payment-provider connection, callbacks, and authorization boundaries.

## 3. P0 modules

### Application Registry

Owns:

- applications
- application domains
- branding metadata
- allowed callback URLs
- application API credentials
- provider connection references

Public/hosted requests resolve the application from the HTTP `Host` header. Server-to-server requests authenticate with an application credential and derive the application from that credential. Caller-supplied `application_id` must never override authenticated/host-derived context. The `Host` fallback is read-only: money-mutating SDK endpoints (checkout, credits, usage report, portal sessions, customers) reject host-only requests with `401 credential_required` and require an application credential.

### Customer Registry

MonetPlane is **not an identity provider in P0**.

Each application supplies a stable external customer identifier. MonetPlane stores the mapping needed for monetization:

```text
Customer
  └── ApplicationCustomer
        ├── application_id
        └── external_customer_id
```

Cross-application customer linking must be explicit. MonetPlane must never auto-merge identities merely because two applications supplied the same email address.

### Catalog

Core concepts:

```text
Product
  └── Price
       ├── one_time
       └── recurring
            ├── month
            └── year
```

A product describes what is sold. A price describes how it is charged. Entitlement and credit grants describe what the customer receives.

### Commerce

Owns the normalized commercial state:

- checkout sessions
- orders / order items
- payments
- refunds
- subscriptions / subscription items
- provider references

Provider redirects are user-experience signals only. **Signed provider webhooks are the source of truth for payment/subscription state.**

### Provider Adapter Layer

Provider-specific APIs, event names, signatures, and identifiers stay behind a common contract. Shipped adapters: Creem, Waffo, and PayPal (plus a contract-conformance `mock` used by tests), proving that the core is not coupled to one provider. Adapter authors reuse the shared kit in `src/modules/providers/adapters/shared.ts` (guards, credential classification, fetch with timeout) and the currency registry in `src/lib/money.ts` — adapters must not re-implement these locally.

See [provider contract](provider-contract.md).

### Entitlements

Entitlements answer:

> What may this customer use right now?

Products do not inspect payment-provider state directly. They query MonetPlane by feature key and application/customer context.

Example:

```text
feature: advanced_agent_lab
state: granted
source: subscription/sub_xxx
valid_until: 2026-09-18T00:00:00Z
```

### Credits

Credits answer:

> How much consumable usage does this customer have left?

P0 supports:

- purchase/top-up grants
- subscription renewal grants
- admin adjustments
- direct debit
- reserve → capture / release
- refund/reversal
- idempotent mutation
- auditable ledger

See [credits ledger](credits-ledger.md).

### Billing Operations Journal

Operator-driven mutations (console refunds, cancellations, retries) are recorded
in a billing-operations journal before the provider call, with idempotency keys,
explicit retry semantics, and reconciliation for uncertain outcomes. The journal
operation layer also owns the operator audit entry: the audit row commits in the
same transaction as the journal completion, so every money mutation is exactly
once-audited.

### Developer Lifecycle Events

Committed provider webhook effects fan out to developer-configured webhook
endpoints as signed, provider-neutral events. Event identity is **fact-based**
(#131): payments key on (connection, providerPaymentId, outcome), refunds on
(connection, providerRefundId), renewals on (connection, subscriptionId,
periodStart) — the same business fact always carries the SAME event id, so the
per-endpoint `(endpoint, eventId)` uniqueness is fact-level dedup and consumers
can treat the id as a stable idempotency key even when the provider regenerates
its own event ids on retry. Publisher: `src/server/control-plane/billing-events.ts`.
A protected sweeper (`GET/POST /api/cron/webhook-deliveries`, `CRON_SECRET`, every 1–5 min)
re-delivers deliveries left `pending` by a crash between insert and attempt
(exponential backoff, atomic claim, max attempts → failed).

### Webhook Inbox

Every provider event is first persisted into an inbox with a unique provider event identifier before business effects are applied.

```text
verify signature
      ↓
insert WebhookEvent (unique provider + event_id)
      ↓
normalize event
      ↓
apply commerce state transition
      ↓
apply entitlement / credit effects
      ↓
mark processed
```

Duplicate deliveries must return success without duplicating effects.

Response policy (post #118): permanent validation failures answer `422 {permanent: true}`
(deterministic — retrying cannot fix them); transient failures answer `503` so the
provider's redelivery acts as the automatic retry path (failed inbox rows are
reprocessable); signature failures stay 401 and unregistered adapters 404.

## 4. Core domain model

```text
Application
 ├── ApplicationDomain
 ├── ApplicationCredential
 ├── ProviderConnection
 ├── Product
 │    └── Price
 │
 └── ApplicationCustomer ─── Customer

Customer + Application
 ├── Order
 │    └── OrderItem
 ├── Payment
 ├── Refund
 ├── Subscription
 │    └── SubscriptionItem
 ├── EntitlementGrant
 ├── CreditAccount
 │    ├── CreditTransaction
 │    └── CreditReservation
 └── WebhookEvent (via provider/application context)
```

## 5. Request flows

### One-time purchase / credit top-up

```text
Product backend
   ↓ authenticated create-checkout
MonetPlane
   ↓ provider adapter
Provider-hosted checkout
   ↓ payment
provider webhook
   ↓ signature + idempotency
MonetPlane
   ├── Payment = succeeded
   ├── Order = paid
   └── grant entitlement and/or credits
```

### Recurring subscription

```text
create checkout
   ↓
provider subscription created
   ↓
provider payment-success webhook
   ↓
Subscription active
   ├── activate/extend entitlements
   └── grant configured recurring credits
```

Renewals repeat through provider webhooks. Failed renewals update subscription/payment state and must not create renewal grants.

### Credit consumption

```text
Product backend
   ↓ server-to-server request + idempotency key
MonetPlane
   ↓ PostgreSQL transaction
atomic balance mutation + ledger entry
   ↓
result + remaining balance
```

Long-running/variable-cost work uses reserve/capture/release instead of an unconditional debit.

## 6. Data and consistency rules

1. Monetary amounts are stored in integer minor units; no floating point money.
2. All external provider objects retain their provider identifiers for reconciliation.
3. Webhook events have unique `(provider_connection_id, provider_event_id)` constraints.
4. Credit mutations have unique application-scoped idempotency keys.
5. Balance mutation and ledger append happen in the same PostgreSQL transaction.
6. No credit account may commit a negative available balance.
7. Entitlement activation is derived from normalized commercial events, never from browser redirects.
8. Secrets are never returned by public/admin APIs after creation.
9. Provider credentials stored by MonetPlane must be encrypted at rest with an installation-level encryption key.
10. A provider event's currency must match the recorded payment/order currency; mismatches fail the event before any write.
11. A settled payment's `amountMinor`/`currency` are immutable — later events never overwrite them (drift is logged for inspection).
12. Refunds are capped at the captured amount minus already-succeeded refunds; only a cumulative-full refund flips payment/order to `refunded` and revokes entitlements.

## 7. P0 reference stack

Keep the first implementation operationally small:

- TypeScript
- Next.js full-stack application for hosted pages, dashboard, and HTTP APIs
- PostgreSQL (Neon-compatible)
- a type-safe SQL/ORM layer
- Vercel-compatible deployment, while remaining runnable with a normal Node runtime

No queue, Kafka, Redis, microservice split, or separate analytics database is required for P0. The webhook inbox provides the first durable asynchronous boundary.

## 8. P0 security boundaries

- Product browsers cannot mutate credits directly; consumption is server-to-server.
- Application credentials are scoped to one application.
- Hosted-domain routes derive application context from an allow-listed host; host-only
  reads of balances/entitlements are rate limited with an anomaly signal (#127
  transitional control — credential auth is the preferred read path). Client identity
  comes from `x-forwarded-for` ONLY when `MONETPLANE_TRUST_PROXY=true` (deployed behind
  a proxy that overwrites it); otherwise all host-only clients share one bucket per
  application. The window map is hard-capped and the limiter fails closed when full.
- Callback/return URLs must match application allow-lists to prevent open redirects.
- Provider webhook signatures are verified before event persistence/effects.
- Admin/provider secrets are encrypted and redacted.
- Every credit/payment effect is traceable to a source/reference.

## 9. P0 definition of done

The architecture is proven when:

1. One MonetPlane deployment serves at least two application contexts/domains.
2. Both applications have isolated catalogs, customers, provider configuration, entitlements, and credits.
3. One-time checkout and recurring subscription flows can be expressed through the common provider contract.
4. At least two real provider adapters validate the provider-agnostic abstraction, or one real provider plus a second contract-conformance adapter is available until production credentials are obtainable.
5. Duplicate webhooks cannot duplicate orders, entitlements, or credit grants.
6. Concurrent credit consumption cannot overspend.
7. A failed long-running job can release reserved credits without changing the final balance.
8. Product code can integrate through the same SDK/API regardless of payment provider.

## 10. Deferred beyond P0

- full IAM / SSO
- automatic cross-application identity federation
- teams/organizations for end customers
- tax calculation independent of payment/MoR provider
- invoices/accounting ledger
- affiliate/referral system
- multi-currency wallet
- credit expiration/rollover **policy engine** (basic scheduled expiry of expiring credit buckets ships via the protected cron route `GET /api/cron/credit-expiry`)
- complex usage metering aggregation
- asynchronous event bus / distributed services
