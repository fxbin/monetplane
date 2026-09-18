# Analytics Metric Definitions (v1)

Operational analytics for the console (`src/server/control-plane/analytics.ts`).
Every metric below is implemented by the deterministic fixtures in
`tests/integration/analytics-v1.test.ts`.

## Currency policy

**Amounts are never summed across currencies.** Every revenue/MRR
aggregate groups by `currency` and renders as separate entries. Views that
show more than one currency label the mix explicitly. There is no FX
conversion (non-goal).

## Revenue and payments

- **Volume by currency** — `sum(amount_minor)` of `payments.status =
  'succeeded'` in the period, per currency. Refunds do not subtract from
  this metric; refunded amounts are reported as a separate count.
- **Success rate** — `succeeded / (succeeded + failed)` payments in the
  period. `refunded` and `pending` are excluded from the denominator.
  `null` when no terminal attempts exist (never a fabricated 0%/100%).
- **By product / by provider** — from paid orders' line items and
  succeeded payments respectively, always split by currency.

## Subscriptions and MRR

MRR = sum over **active** subscriptions of each item's snapshot terms
normalized to one month, grouped by currency:

| interval | normalization |
|---|---|
| week | `amount × 52 / 12` |
| month | `amount` |
| year | `amount ÷ 12` |

Normalized values round to integer minor units. Status counts
(active/past_due/cancelled/expired) come from the subscriptions table in
the selected environment.

## Provider health

Computed **only from observed MonetPlane runtime records** — never from
fabricated availability claims:

- Operations per provider from `billing_operations`.
- Failures split into **rejected** (provider declined deterministically)
  vs **outcome_uncertain** (unknown result, needs reconciliation) via
  `failure_kind` — customer/payment rejection stays distinguishable from
  uncertain outcomes.
- Average operation duration from `completed_at − created_at` on
  completed operations.
- Webhook delivery health: succeeded/failed/pending counts.

## Usage

- **By meter** — `sum(quantity)` of usage events in the period, per
  meter key, with event counts.
- **Top consumers** — per external customer, ranked by measured quantity
  (bounded to 10).

## Environment isolation

All queries filter by the console environment via the environment column
implemented in #74. Empty or partial data returns zeroed/empty aggregates
that the UI renders as explicit empty states.
