# Credits and Usage Ledger

Credits are a core MonetPlane primitive. They represent consumable product usage such as AI runs, image generations, reports, or tutor sessions.

P0 treats credits as an **application-scoped ledger**, not as a single mutable number on a user record.

## Goals

- Real-time balance checks and consumption.
- No negative balance under concurrent requests.
- Full audit trail for every grant, debit, refund, and adjustment.
- Safe long-running work through reserve/capture/release.
- Idempotent mutations across retries.
- Credits isolated by application and credit type.

## Account model

```text
CreditAccount
- id
- application_id
- customer_id
- credit_type
- available_balance
- reserved_balance
- version/timestamps

UNIQUE(application_id, customer_id, credit_type)
```

An application may define more than one credit type, for example:

```text
ahaframe.agent_run
pictofu.image_generation
mystic.deep_analysis
```

Credits are not globally interchangeable across applications unless a future wallet layer explicitly implements conversion rules.

## Ledger

Every balance-changing action appends a transaction:

```text
CreditTransaction
- id
- credit_account_id
- type
- amount
- available_after
- reserved_after
- source_type
- source_id
- idempotency_key
- metadata
- created_at
```

Transaction types include:

```text
grant.purchase
grant.subscription
grant.promotion
debit.usage
reserve.usage
capture.usage
release.usage
refund.usage
adjustment.admin
grant.expired      // time-triggered: a bucket's cycle ended
grant.revoked      // contract-triggered: the subscription was cancelled
```

`grant.expired` and `grant.revoked` are strictly separate ledger types:
expiry is the passage of a period; revocation is the end of a contract.
They never substitute for each other in reports or reconciliation.

The ledger is the audit history; the balances on `CreditAccount` are the fast current-state projection.

## Idempotency

Every external mutation carries an idempotency key.

Example:

```text
application: ahaframe
idempotency_key: agent_run_8923:reserve
```

A database uniqueness constraint ensures a retry returns the already-applied result rather than charging again.

Recommended uniqueness boundary:

```text
UNIQUE(application_id, idempotency_key)
```

Payment-derived grants use the normalized payment/subscription event identity as their idempotency source.

## Direct debit

Use direct debit only for deterministic, short operations where failure after charging is not a meaningful risk.

The logical mutation must be equivalent to an atomic PostgreSQL operation:

```sql
UPDATE credit_accounts
SET available_balance = available_balance - :amount
WHERE id = :account_id
  AND available_balance >= :amount
RETURNING available_balance;
```

The account mutation and corresponding ledger insertion occur in **one transaction**.

If no row is updated, the result is `insufficient_credits`.

Never implement:

```text
SELECT balance
→ application-side comparison
→ UPDATE balance
```

because concurrent requests can overspend.

## Reserve → Capture / Release

Long-running or variable-cost work uses reservations.

### Reserve

Reservations never draw on expired credits. Inside the single reservation
transaction the service locks the account row first (canonical
account → buckets order), runs the account-scoped expiry sweep, and only
then evaluates the conditional balance check. If the balance is
insufficient after expiry, the transaction still commits — the expiry
work must survive a rejected reservation — and `InsufficientCreditsError`
is raised after commit. There is no window between "expiry applied" and
"reservation evaluated" where a concurrent release could make expired
credits spendable again.

Customer has:

```text
available = 100
reserved  = 0
```

Reserve 50:

```text
available = 50
reserved  = 50
```

The reservation stores:

```text
CreditReservation
- id
- credit_account_id
- reserved_amount
- captured_amount
- status                 // active | captured | released | expired
- reference_type
- reference_id
- idempotency_key
- expires_at?
- created_at
- updated_at
```

### Capture

If an operation reserved 50 but actually costs 32:

```text
before capture
available = 50
reserved  = 50

capture 32 + release unused 18

final
available = 68
reserved  = 0
```

The customer paid only the actual 32 credits.

Capture deliberately **grandfathers** the reservation: it settles with
`allowExpired`, so a reservation made before a bucket expired still
captures against that bucket afterwards. Expiry guards new spending
(reserve/debit), not the settlement of work already reserved and in
flight.

### Release

If the operation fails before any billable work completes:

```text
available = 100
reserved  = 0
```

A repeated release/capture request must be idempotent.

## Transaction boundaries

Each mutation is atomic:

```text
BEGIN
  validate idempotency
  lock/mutate credit account
  create/update reservation when applicable
  append ledger transaction
COMMIT
```

Any failure rolls back all steps.

For P0, PostgreSQL is the consistency authority. Redis or an in-memory cache must never become the source of truth for balances.

## Payment and subscription grants

### Credit top-up

```text
payment.succeeded
   ↓
paid order item grants 500 credits
   ↓
CreditTransaction +500 grant.purchase
```

Duplicate provider webhooks reuse the same normalized source/idempotency identity and cannot grant twice.

### Subscription grant

```text
subscription initial payment / renewal succeeded
   ↓
configured recurring grant
   ↓
CreditTransaction +N grant.subscription
```

A failed renewal never grants a new period's credits.

Renewal grants are idempotent per billing cycle: the grant idempotency key derives
from the renewal's period start, and a renewal that arrives without its own period
boundaries (e.g. PayPal `PAYMENT.SALE.COMPLETED`, enriched from the subscription API
when possible) keys off the provider event id instead — stable across redeliveries,
unique per cycle, so a paid cycle can never collide with the previous cycle's grants.

**Period-reset quota semantics**: a subscription cycle's credit grant lands in a
bucket that expires with the cycle's own `periodEnd`; the next cycle's grant lands
in a fresh bucket. A monthly plan granting 1,000 credits/month therefore accumulates
at most one live cycle of quota — unused credits do not roll into the next cycle
(rollover limits remain a deferred item, see the end of this document).

**Boundary-less renewals fail closed for credits.** In this ledger
`expiresAt: NULL` means "permanent asset"; a renewal that would grant credits
without its own period boundary cannot be allowed to mint permanent credits, nor
may it reuse the stale stored period (the new cycle's credits would be born
expired while colliding with the previous cycle's idempotency keys). The webhook
inbox marks the event failed and the provider redelivery — now carrying the
boundary — heals it: a failed inbox row being redelivered is re-armed with the
current delivery's payload before processing, so the same event id can succeed on
its second arrival and grant exactly once. Benefits-only subscriptions (no credit
grant config) are unaffected by this requirement.

## Cancellation clawback

When a subscription ends, its unused cycle credits are revoked:

```text
subscription cancelled (webhook event)      or   immediate cancel (journaled reconcile)
   ↓
revokeSubscriptionCreditsInTransaction()
   ↓
CreditTransaction -N grant.revoked          (bucket → status=reversed)
```

- Both trigger paths — the webhook cancel branch and the journaled immediate-cancel
  reconcile (provider synchronous cancels, e.g. Creem) — call the same
  transaction-scoped core; no ledger write happens outside a transaction.
- Revocation is idempotent per bucket with monotonic keys
  (`revoke:{subscriptionId}:{bucketId}:before:{remainingBefore}`): a replayed
  cancel cannot revoke twice, and concurrent attempts serialize on the account
  row lock (accounts locked in sorted order, then buckets).
- Fully-drained buckets transition to `status=reversed`; buckets created before
  the period-reset model (legacy permanent buckets) are grandfathered rather than
  revoked — scope decision recorded in `.agents/notes/`.
- The ledger invariant holds throughout:
  `sum(active bucket remaining) == availableBalance + reservedBalance`.

## API semantics

P0 exposes server-side operations equivalent to:

```text
GET  /v1/credits/:creditType/balance
POST /v1/credits/:creditType/debit
POST /v1/credits/:creditType/reservations
POST /v1/credits/reservations/:id/capture
POST /v1/credits/reservations/:id/release
```

Mutation APIs require:

- authenticated application context
- customer reference
- positive integer amount
- idempotency key
- source/reference metadata

Product browsers must not possess credentials that can perform credit mutations.

## Failure cases P0 must test

1. 100 concurrent debits against a limited balance never create a negative balance.
2. Retrying the same debit idempotency key charges once.
3. Retrying a reserve charges/reserves once.
4. Capturing a reservation twice does not charge twice.
5. Releasing a reservation twice does not restore twice.
6. Capture and release races produce one valid terminal state.
7. Ledger failure rolls back the balance mutation.
8. Duplicate payment webhooks grant credits once.
9. A customer cannot spend credits belonging to another application or credit type.
10. Reserved credits cannot be spent by unrelated direct debits.
11. A reservation made before bucket expiry still captures afterwards
    (grandfather); a NEW reservation after expiry is rejected.
12. A replayed cancellation webhook revokes unused cycle credits exactly once.

## Credit bucket expiry (cron)

Every grant creates one auditable bucket (`credit_buckets`). Buckets support
**partial expiry**: the sweep expires `min(bucket.remainingAmount,
account.availableBalance)` immediately — the portion of a bucket backed by
available balance — while a residual backed by open reservations stays active
until those reservations settle (capture consumes it with grandfathering;
release-back residuals are retired by the next sweep with monotonic
`expire:{bucketId}:before:{remainingBefore}` idempotency keys, so an overlapping
or replayed sweep can never double-reverse).

Expired buckets do not transition themselves: the only writer that moves due
buckets out of `active` (and reverses their remaining amount through a
`grant.expired` ledger entry) is `expireDueCreditBuckets()` — plus its
account-scoped variant, which runs inline at the start of reserve/debit
transactions so new spending always evaluates a clean balance. Until a sweep
runs, expired credits remain spendable and the documented invariant drifts:

```text
sum(active bucket remaining) == availableBalance + reservedBalance
```

Production deployments must therefore schedule the protected cron endpoint:

```text
GET|POST /api/cron/credit-expiry
Authorization: Bearer ${CRON_SECRET}
```

- Auth is a shared secret compared with `timingSafeEqual`; the endpoint fails
  closed (401) when `CRON_SECRET` is unset or mismatched.
- A successful run returns `{ "expiredBuckets": <count>, "expiredAmountMinor":
  <sum> }`; failures return 500 with `{ "error": "..." }`. Both are safe to
  retry: expiry re-validates every bucket under row lock, so overlapping runs
  (or a run racing a debit) never double-reverse.
- Schedule every 5–15 minutes. Example manual invocation:

```bash
curl -X POST https://your-host/api/cron/credit-expiry \
  -H "Authorization: Bearer $CRON_SECRET"
```

Scheduling options:

- **Generic scheduler** (system crontab, Kubernetes CronJob, GitHub Actions
  scheduled workflow, uptime pinger): hit the endpoint on a `*/10 * * * *`
  schedule with the header above. This works on any host, including the plain
  Node runtime deployment this repo targets.
- **Vercel Cron**: add to `vercel.json` (this repo currently has none — there
  are no Vercel deployment signals beyond a "Vercel-compatible" note in
  docs/architecture.md, so none is checked in):

```json
{
  "crons": [{ "path": "/api/cron/credit-expiry", "schedule": "*/10 * * * *" }]
}
```

  Note Vercel's plan restrictions: Hobby plans only allow schedules that run
  once per day (e.g. `0 3 * * *`), Pro and above honor `*/10 * * * *`. If you
  deploy on Vercel Hobby, prefer the daily schedule or an external scheduler
  for the 5–15 minute cadence.

Locking note: bucket rows are mutated under `SELECT ... FOR UPDATE` in a
canonical order (account row first, then buckets ordered by
`expiresAt ASC NULLS LAST, createdAt ASC, id ASC`). Concurrent debits,
captures, and expiry runs therefore serialize without deadlocks or lost
updates.

**Console entry**: the admin grant route (`POST /api/admin/customers/{id}/credits`)
accepts `expiresAt` (ISO 8601) or `expiresInDays` (whole days), and the grant
dialog exposes the days form. The reservation sweeper remains a separate open
item — reservation rows carry `expiresAt` but are not auto-expired in this
release; capture and release are the settlement paths.

## Deferred after P0

- rollover limits
- shared cross-application wallets
- monetary conversion between credit types
- negative/postpaid balances
- usage aggregation windows
- tiered/volume pricing meters
