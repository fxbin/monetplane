# Creem Catalog Mapping — Console Operations & Recovery

How MonetPlane prices map to Creem products: what the console does, what
the provider supports, and how to recover when an automated create goes
wrong. For the adapter authoring perspective see
[provider-adapter-guide.md](./provider-adapter-guide.md); for the
decision record behind the design see
`.agents/notes/implemented/architecture/2026-10-08-creem-catalog-mapping-precedence.md`
and `.../2026-10-09-creem-catalog-provisioning-idempotency.md`.

## Model

- **Mapping granularity is per price.** One MonetPlane price ↔ at most one
  Creem product per `(application, environment, provider connection)`. A
  product with monthly and annual prices has **two** independent mappings —
  create/link them separately.
- **Sources:** `linked` (an existing product was verified and bound) or
  `created` (MonetPlane created the product at the provider). Sources are
  informational; both behave identically at checkout.
- **Checkout precedence:** a `synced` mapping from the
  `provider_catalog_mappings` table wins; otherwise adapters fall back to
  the legacy `provider_connections.metadata.catalog` entry exactly as
  before. The legacy metadata is never written or migrated; a price with a
  legacy entry cannot be auto-created (link the product instead) and a
  link that conflicts with it is refused.

## Creem interface boundaries (verified 2026-10-08)

| Dimension | Supported | Notes |
|---|---|---|
| Currencies | `USD`, `EUR` | Pre-flight rejected otherwise |
| Price | `0` (free) or ≥ 100 minor units | Creem minimum |
| Billing | one-time; recurring `every-month` / `every-three-months` / `every-six-months` / `every-year` / custom (`week|month|year` × count) | Weekly plans are refused for Creem (no `weekly_interval`) |
| Tax categories | `saas`, `digital-goods-service`, `ebooks` | Optional |
| Read | `GET /v1/products/{id}` | Path-parameter form per current reference |
| Create | `POST /v1/products` with `Idempotency-Key` | Key = mapping row id; replays return the original product |
| Environment | `test` connections only ever reach `https://test-api.creem.io` | Mode comes from the connection; the console environment is cross-checked |

Every create is verified **bidirectionally**: the returned id is re-read
via GET and compared field-by-field (currency, amount, billing type,
interval × count, mode, status) before the mapping is marked `synced`. A
product that mismatches is parked with its id for manual reconciliation —
false success is never recorded.

## Sync states and recovery

| State | Meaning | Console actions |
|---|---|---|
| Not configured | No mapping row | **Create in Creem** / **Link existing** |
| Pending / Creating | An attempt is in flight | Wait; stale attempts (>5 min) are parked automatically on the next request |
| Synced | Mapping live, checkout uses it | None (no second product offered) |
| Needs reconciliation | Uncertain outcome — the create MAY have landed; the product id may or may not be known | Find the product in the Creem dashboard, **link it to adopt**; or **mark failed** and retry |
| Failed | Deterministic rejection (4xx, pre-flight, exhausted 429) | Retry **Create** (same idempotency key — cannot fork a duplicate) / **Link existing** |

**Why uncertain outcomes never auto-retry:** a timeout may have created
the product; re-POSTing would risk a duplicate. Although Creem's
documented `Idempotency-Key` makes a same-key replay return the original
product, MonetPlane treats that behavior as unverified until the real
Sandbox gate (#157) confirms it — recovery is always an explicit,
audited operator action. Every attempt carries a per-claim ownership
token (`attempt_token`), so a late response from a superseded attempt can
never write over a newer one, and stale-parking compares the observed
row version (`updated_at`) so committed progress is never parked over.

## Webhook receiving vs SDK checkout — who does what

- **SDK / business app** (`mp_app_*` credentials): creates customers,
  initiates checkout with `priceId`s. It never sees Creem credentials; the
  provider call happens server-side from MonetPlane using the mapping.
- **Creem → MonetPlane webhook** (HMAC-signed, per-connection secret):
  the source of payment truth. Checkout completion, order `paid`,
  entitlement activation all flow from verified webhooks — never from the
  checkout redirect alone.
- **Console operators** (session + `catalog:write`): manage products,
  mappings, and recovery. All outcomes are written to the operator audit
  log (`provider_catalog.*` actions) with actor, application,
  environment, connection, price, and — when safely known — the provider
  product id. No credentials ever appear in responses, pages, or audit
  entries.

## Database recovery / upgrade notes

- Migrations are **explicit**: deploy new code only after its migrations
  are applied (checkout fails closed on a missing table). `0021` created
  the mapping table; `0022` added the attempt-token column.
- An uncertain intent survived a full application crash is safe by
  construction: the row stays `needs_reconciliation`, the created product
  id (if the POST returned before the crash) was persisted before the
  verification read, and recovery is adoption via the console.
- Restoring a database snapshot reverts mapping rows; a product created
  before the snapshot stays at Creem, unreferenced by the restored rows. A
  re-created mapping after restore uses a NEW row id (new idempotency
  key), so a fresh create cannot collide with the orphan. If a snapshot
  restores a `creating` row whose product was actually created, treat it
  as needs-reconciliation: find the product in the Creem dashboard and
  link it.
- Upgrades keep legacy `metadata.catalog` behavior for connections that
  never opted into managed mappings; rolling back the feature is dropping
  the mapping table (and the 0022 `attempt_token` column) — checkout then
  falls back to legacy metadata.

## Real-Sandbox acceptance (external evidence, #157)

The gates that mocks cannot close — record the evidence on the issue:

1. Path A: existing Creem test product → console link → `synced` → SDK
   checkout against it.
2. Path B: new price → console create → provider product id returned →
   `synced` → SDK checkout.
3. Sandbox payment → signed webhook → order `paid`, payment `succeeded`,
   entitlement `active`; duplicate webhook delivery grants once;
   unsigned/bad signature still 401.
4. Negative cases: cross-connection/app/environment, amount/currency
   mismatches, uncertain-create recovery via adoption.
5. Integration suites only ever run against an isolated test database.
