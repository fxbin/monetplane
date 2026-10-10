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
- **A database snapshot rollback is NOT a catalog rollback.** Restoring a
  snapshot reverts mapping rows, but a product created before the snapshot
  stays at Creem — and a mapping created after the restore gets a NEW row
  id, hence a NEW idempotency key. That key CANNOT dedupe against the
  orphaned product: clicking Create again would produce a **second
  external product**. After any snapshot restore involving in-flight
  provisioning, recover in this order:
  1. Pause automatic creation for the affected prices.
  2. Search the matching Creem environment (Test/Live follows the
     connection mode) for products that may already have been created.
  3. Verify identity — amount, currency, billing type, period — against
     the MonetPlane price.
  4. If a product is found, recover the mapping through the audited
     **Link existing** flow (adoption).
  5. Only when no original product exists, start a new create intent.
- If a snapshot restores a `creating` row whose product was actually
  created, treat it as needs-reconciliation (stale-park or manual) and
  follow the same search-then-adopt order above.
- Upgrades keep legacy `metadata.catalog` behavior for connections that
  never opted into managed mappings.
- **Rollback rule (both directions verified):**
  1. **Before rolling back application code**, confirm the TARGET VERSION
     can correctly resolve the Provider Product ID for EVERY affected
     price. Pre-#158 versions read only legacy `metadata.catalog` — a
     price whose product id lives solely in `provider_catalog_mappings`
     would lose its checkout source even though the table is kept. If
     that compatibility cannot be verified, rolling back to that version
     is FORBIDDEN; use a target version that reads both sources, or
     backfill/repair the legacy mapping first.
  2. By default, KEEP the database mappings and audit data. Rolling back
     via DROP-ing the mapping table is forbidden.
  3. Any later cleanup of the new table requires mapping-integrity
     verification (every affected price resolves in the running version),
     backup reconciliation, and manual approval.

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
