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
```

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

P0 grants accumulate. Credit expiration, rollover limits, and bucket-consumption policy are intentionally deferred until after the basic ledger is proven.

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

## Deferred after P0

- expiring grants
- FIFO/LIFO credit buckets
- rollover limits
- shared cross-application wallets
- monetary conversion between credit types
- negative/postpaid balances
- usage aggregation windows
- tiered/volume pricing meters
