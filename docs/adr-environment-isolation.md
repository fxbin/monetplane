# ADR: Sandbox/Production Environment Isolation Model

Status: Accepted (decision gate for #49; implementation in #74) ·
Date: 2026-09-17

## 1. Chosen model — "Shared definitions, environment-scoped runtime"

The application (project) remains the global isolation boundary. Within a
project, MonetPlane uses **two environment planes**, `test` (Sandbox) and
`live` (Production):

- **Definition/configuration data is shared** across environments:
  catalog (products, prices), customer identity mapping
  (`application_customers`), application domains/branding/callback
  origins, developer server API keys (project-wide credentials).
- **Billing runtime data is environment-scoped**: every runtime entity
  carries an explicit, immutable `environment` column (`'test' |
'live'`) captured at creation time from the provider connection (or the
API caller's explicit environment).

Rationale:

1. Mirrors how operators actually use Sandbox: they want to rehearse the
   *same* product catalog against test payment providers without
   duplicating definitions.
2. An explicit column (rather than deriving isolation only through
   `provider_connections` joins) makes isolation constraints enforceable
   in the database (`CHECK`, composite unique keys) and keeps isolation
   queries impossible to write incorrectly by forgetting a join.
3. Sharing customer identity keeps one `external_customer_id` per human,
   which matches how SDK callers upsert customers; only their billing
   state (orders, subscriptions, balances) splits by environment.

## 2. Entity-by-entity isolation matrix

| Entity | Decision | Rationale / notes |
|---|---|---|
| `applications` | Shared | Project = global boundary |
| `products`, `prices` | Shared | One catalog; environment is a runtime concern |
| `application_customers` (+ global `customers`) | Shared identity, isolated runtime | One external ID per human; billing state lives in child rows |
| `application_credentials` (API keys) | Shared (project-wide) | Server credentials choose environment per request; rotating per env doubles operational burden with no security gain |
| `application_domains` / `application_branding` / `application_callback_origins` | Shared | Configuration, not runtime |
| `provider_connections` | Isolated (existing `mode`) | Already environment-scoped; keep column name `mode`, expose as environment |
| `checkout_sessions` | **Isolated** (new `environment`) | Created from a provider connection; capture env at creation |
| `orders` + `order_items` | **Isolated** | Order status is runtime state |
| `payments` | **Isolated** | Provider money events must never mix |
| `refunds` | **Isolated** | Follows payment |
| `subscriptions` + `subscription_items` | **Isolated** | Billing lifecycle state |
| `entitlements` | **Isolated** | Grants come from environment-scoped orders/subscriptions |
| `credit_accounts`, `credit_transactions`, `credit_reservations` | **Isolated** | Sandbox debits must not consume Production balance |
| `usage_records` (future, #62) | **Isolated** | Metered usage bills real money only in `live` |
| `webhook_events` (provider inbox) | **Isolated** | Derived from provider connection mode |
| Developer `webhook_endpoints` / `webhook_deliveries` | **Isolated** (existing `mode`) | Already correct in P1 |
| Billing operation journal (`billing_operations`) | **Isolated** | Reconciliation history must not cross planes |
| Future audit rows (#66) | **Isolated** | Audit trail follows the data it describes |

## 3. Schema / constraint impact

- New `environment text NOT NULL CHECK (environment IN ('test','live'))`
  on: `checkout_sessions`, `orders`, `payments`, `refunds`,
  `subscriptions`, `entitlements`, `credit_accounts`,
  `credit_transactions`, `credit_reservations`, `webhook_events`,
  `billing_operations`.
- Environment is **immutable** after insert (enforced by trigger in #74).
- Consistency with the provider plane: composite FK
  `(provider_connection_id, environment)` referencing a unique key on
  `provider_connections (id, mode)` where an entity carries a provider
  connection.
- Unique/idempotency keys gain environment as part of identity:
  - `credit_transactions`: `(application_id, environment, idempotency_key)`
  - `payments`: `(provider_connection_id, provider_payment_id)` stays
    (connection already implies environment)
  - `orders`/`checkout_sessions`: keep provider-scoped IDs; add
    `(application_id, environment)` to lookup indexes
  - `credit_accounts` unique scope: `(application_id,
    application_customer_id, credit_type, environment)`
  - `subscriptions`: provider-scoped unique unchanged
- Indexes: every runtime table gets `(application_id, environment,
  created_at)` covering the console's default query shape.

## 4. API / SDK / console behavior

- **Server SDK**: every runtime endpoint accepts an optional
  `environment` field (`"test" | "live"`). **Fail-closed defaults**: the
  SDK always sends `environment`; if the caller omits it the server
  rejects runtime mutations with `400 environment_required` rather than
  guessing. Reads default to `"test"` only when explicitly configured on
  the client (`createMonetPlaneClient({ defaultEnvironment })`).
- **Provider webhooks**: environment derived from the receiving
  provider connection — no caller input.
- **Admin API** (`/api/admin/*`): environment comes from the console
  context cookie (`monetplane_console_environment`); validated server
  side.
- **Cross-plane references fail closed**: a `live` checkout cannot
  reference a `test` provider connection (CHECK/FK above), a runtime
  read cannot join across environments, and admin endpoints reject
  mismatched environment + connection pairs.
- Production may never reference Sandbox configuration beyond the shared
  catalog; the shared catalog contains no secrets.

## 5. Migration / backfill strategy (#74)

1. Add nullable `environment` columns; backfill:
   - `payments`, `subscriptions`, `webhook_events`, `billing_operations`:
     from `provider_connections.mode`.
   - `orders`: from the payment with the same order, else the checkout
     session's provider connection, else `'test'` **plus an operator
     report of defaulted rows** (P0/P1 test data dominates).
   - `credits`/`entitlements`: `'test'` backfill with the same explicit
     operator report; pre-#74 data was de-facto sandbox usage.
2. Apply `NOT NULL` + `CHECK` + new unique constraints in the same
   migration batch.
3. Ship as a single forward-only migration; no down-migration (unique
   keys must not be dropped silently).

## 6. Rollout / compatibility risks

- Old SDK clients without `environment` will receive
  `400 environment_required` on mutations — a breaking change gated by
  a major SDK version (#65); until then the server may accept and
  default to `"test"` **only** while logging a deprecation warning; the
  flag flips to hard-fail when #65 publishes the versioned SDK.
- Backfill defaults could mislabel historical production rows — mitigated
  by the operator report and the fact that P0/P1 deployments have been
  sandbox-scale.
- UI copy that says "shared across environments in this release" must be
  updated in #74 to describe real isolation.

## 7. Test matrix for #74

1. Same `idempotency_key` in `test` and `live` credits both succeed
   independently (unique key includes environment).
2. `live` checkout with a `test` provider connection is rejected
   (fail-closed FK/CHECK).
3. Environment column is immutable on update attempts.
4. Sandbox debit does not change Production balance (accounts split).
5. Console environment switch shows fully disjoint runtime data for the
   same project + customer.
6. Provider webhook routed through a `test` connection never writes
   `live` rows.
7. Migration backfill: seeded mixed-mode fixture produces correct
   environment labels + operator report.
8. SDK: omitted environment on mutation → `400 environment_required`
   (after the deprecation window).

## 8. Current behavior (until #74 lands)

- Project selection remains the real global isolation boundary.
- Sandbox/Production selects provider configuration, developer webhook
  endpoints/deliveries, and environment-aware console reads.
- Catalog, customers, credits, entitlements, orders remain
  project-scoped; UI/API/SDK copy must keep saying so and must not claim
  Stripe-like full Test/Live isolation.
