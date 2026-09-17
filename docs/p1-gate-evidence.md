# P1 Gate (#45) Acceptance Evidence

Date: 2026-09-17 · Branch: `chore/p1-gate` · Console build: main + gate fixes

Environment: local dev server (`pnpm dev`, Node 24), real PostgreSQL
(`monetplane_test`), real console UI in a real browser (Chromium via
in-app browser automation). All evidence below was collected live; no
fixtures were presented as real-provider proof. Mock-provider checkouts
are explicitly labeled as such (the mock adapter is intentionally not
registered in production runtime; Creem/Waffo sandbox mutation evidence
remains tracked by #41).

## Core journey

| Step | Evidence | Result |
|---|---|---|
| Login | `/login` with `ADMIN_PASSWORD`, redirected to `/overview` | ✅ |
| Create/select application | Project switcher lists `Verify Ops` / `Operations Env`; selected `Verify Ops` | ✅ |
| Select Sandbox/Production | Environment toggle renders with Sandbox pressed; KPIs/provider tables scoped by env (live view showed 0 revenue + missing-provider warning) | ✅ |
| Connect/configure provider | `Verify Ops` has active mock/waffo/creem connections in Sandbox; providers page lists them | ✅ |
| Create product/price | `Starter License` ($49 one-time), `Credit Pack 100`, `Pro` (recurring) exist and render on products page | ✅ |
| Reach SDK quickstart | `/developer` renders quickstart with integration-health checklist | ✅ |
| Complete a test checkout | SDK HTTP call (`upsertCustomer` → 201) against the running server; full checkout completed at the commerce layer with the mock provider (`createCommerceCheckout` → `processProviderWebhook` with a signed webhook → order paid, `payment.succeeded` event processed); the new payment, order, and event are visible in the console (`/payments` row, Overview revenue updated $185→$234, `/events` row `evt_gate_final`) | ✅ (mock provider; real-provider sandbox proof tracked in #41) |

## Operations

- Customer billing state: `/customers` list + detail page
  (subscription, balances, entitlements, payment history, movements,
  billing events) ✅
- Payment/subscription/refund state: `/payments`, `/subscriptions`,
  `/refunds` render real data ✅
- Credit balance/ledger: customer detail `Balances` + movements ✅
- Webhook/event failure diagnosis: Overview danger warning links a
  failed payment to `/payments`; `/events` status filter
  (processed/failed/ignored/received) with normalized events ✅

## UI quality

- Desktop layout follows `DESIGN.md`: shared design-system CSS
  (stat cards, tables, badges, restrained palette); Overview command
  center renders warnings above analytics ✅
- Tablet/mobile: 390×844 viewport renders Overview without breakage ✅
- Keyboard/focus: all interactive elements are semantic links, buttons,
  inputs, selects (verified via ARIA tree); no div-click anti-pattern
  found ✅ (no systematic screen-reader pass claimed)
- Empty/loading/error states: guided empty states with next actions
  (fresh project checklist, per-page empty copy) ✅
- Status communication not color-alone: every badge renders a text
  label ✅

## Regression (branch `chore/p1-gate`)

`pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test` 58/58 ✅ ·
`pnpm test:integration` 74/74 ✅ (clean DB) · `pnpm build` ✅ ·
GitHub Actions verify job (incl. migrations ×2 + health check) — see PR
checks.

## Blockers found and fixed during the gate

1. Customer list rendered a literal `{customer.subscriptions.active}`
   template (un-interpolated string) — fixed on this branch.
2. Dev DB was missing migration `0009_developer_webhooks` (applied
   locally; CI always migrates fresh so no product defect).

## Known limitations (tracked elsewhere)

- Real Waffo/Creem sandbox mutation evidence: #41 (kept open).
- Sustained real-product dogfood (P2 gate #68 covers production
  readiness).
