# MonetPlane Server SDK Quickstart

MonetPlane provides a single server-side SDK that lets product teams integrate billing, credits, and entitlements without importing any payment-provider SDK.

## Prerequisites

- A running MonetPlane instance (local or hosted)
- An application registered in MonetPlane with at least one active credential
- Node.js 22+ (the SDK uses the global `fetch` API)

## 1. Register your application

```ts
// One-time setup (run as a script or in the MonetPlane admin)
import { createApplication, issueApplicationCredential } from "@/modules/applications/service";

const app = await createApplication({
  slug: "my-saas-app",
  name: "My SaaS App",
});

const credential = await issueApplicationCredential(app.id, "production-api");
// Save the `credential.secret` — it starts with `mp_app_` and is shown only once.
```

## 2. Configure a provider connection

Register a provider connection (Creem, Waffo, or mock) in the MonetPlane admin or via the API. You will need the `providerConnectionId` for checkout creation.

## 3. Create products and prices

Set up your catalog in MonetPlane with products and prices. Each price has an `id` (e.g. `price_credits_100`) that you pass to the SDK.

## 4. Install the SDK

```bash
# The SDK is part of the MonetPlane monorepo
# For external projects, install from your registry or link locally
```

```ts
import { createMonetPlaneClient } from "@monetplane/sdk/server";
```

## 5. Create a checkout

```ts
const client = createMonetPlaneClient({
  baseUrl: process.env.MONETPLANE_BASE_URL!,    // e.g. https://api.monetplane.com
  appSecret: process.env.MONETPLANE_APP_SECRET!, // mp_app_...
});

// First, upsert the customer
const customer = await client.upsertCustomer({
  externalCustomerId: "user-123",
  email: "user@example.com",
});

// Create a checkout session
const checkout = await client.createCheckout({
  externalCustomerId: "user-123",
  items: [{ priceId: "price_credits_100", quantity: 1 }],
  providerConnectionId: "pc_...",
  successUrl: "https://yourapp.com/success",
  cancelUrl: "https://yourapp.com/cancel",
});

// Redirect the user to `checkout.checkoutUrl`
```

## 6. After the webhook fires — check entitlements and credits

MonetPlane processes the provider webhook and grants entitlements/credits automatically. Your backend can then query state:

```ts
// Check if the user has access to a feature
const { granted } = await client.checkEntitlement({
  externalCustomerId: "user-123",
  featureKey: "premium.features",
});

if (granted) {
  // Grant access
}

// Check credit balance
const balance = await client.getCreditBalance("user-123", "photo.credits");
console.log(`Available: ${balance.available}, Reserved: ${balance.reserved}`);
```

## 7. Debit credits for usage

```ts
const result = await client.debitCredits({
  externalCustomerId: "user-123",
  creditType: "photo.credits",
  amount: 5,
  sourceType: "photo.generate",
  sourceId: "job_abc",
  idempotencyKey: "debit-job-abc", // unique per mutation
});

console.log(`Remaining: ${result.availableAfter}`);
```

## 8. Reserve, capture, and release credits

For long-running jobs, reserve credits upfront, then capture or release:

```ts
// Reserve 50 credits for a job
const { reservationId } = await client.reserveCredits({
  externalCustomerId: "user-123",
  creditType: "photo.credits",
  amount: 50,
  referenceType: "job",
  referenceId: "job_xyz",
  idempotencyKey: "reserve-job-xyz",
});

// After the job completes, capture the used amount
await client.captureReservation({
  reservationId,
  amount: 30,        // only 30 were used
  idempotencyKey: "capture-job-xyz",
});

// The remaining 20 are automatically released back to available
```

## Error handling

The SDK exposes typed, provider-neutral errors:

```ts
import {
  InsufficientCreditsError,
  AuthorizationError,
  UnsupportedCapabilityError,
  InvalidStateError,
  NetworkError,
} from "@monetplane/sdk/server";

try {
  await client.debitCredits({ /* ... */ });
} catch (error) {
  if (error instanceof InsufficientCreditsError) {
    // Handle insufficient balance
  } else if (error instanceof AuthorizationError) {
    // Handle invalid credentials
  } else if (error instanceof NetworkError) {
    // Handle network failures
  }
}
```

## Security notes

- **Never expose `appSecret` in browser code.** The SDK is server-only.
- The `appSecret` is sent as a `Bearer` token in the `Authorization` header.
- All credit mutations require an idempotency key to prevent double-charging.
- Application isolation is enforced at the database level — one application cannot query or mutate another application's customers, credits, or entitlements.

## SDK method reference

| Method | Description |
|---|---|
| `upsertCustomer` | Create or find a customer by external ID |
| `createCheckout` | Create a provider-hosted checkout session |
| `getCreditBalance` | Check available and reserved credit balance |
| `debitCredits` | Deduct credits for usage (idempotent) |
| `reserveCredits` | Reserve credits for a pending job (idempotent) |
| `captureReservation` | Capture a partial or full reservation (idempotent) |
| `releaseReservation` | Release an active reservation back to available (idempotent) |
| `checkEntitlement` | Check if a customer has an active entitlement for a feature |
