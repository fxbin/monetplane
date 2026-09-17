/**
 * Example 1 — basic checkout + entitlement flow.
 * Uses ONLY the packaged SDK contract (no MonetPlane source imports).
 */
import { createMonetPlaneClient } from "@monetplane/sdk/server";

const monetplane = createMonetPlaneClient({
  baseUrl: process.env.MONETPLANE_BASE_URL!,
  appSecret: process.env.MONETPLANE_APP_SECRET!,
});

export async function startCheckoutForUser(
  externalCustomerId: string,
  priceId: string,
) {
  const customer = await monetplane.upsertCustomer({
    externalCustomerId,
    email: `${externalCustomerId}@example.com`,
  });

  // No providerConnectionId: MonetPlane routes the provider (#60).
  const checkout = await monetplane.createCheckout({
    externalCustomerId,
    items: [{ priceId, quantity: 1 }],
    environment: "test",
    successUrl: "https://app.example.com/billing/success",
    cancelUrl: "https://app.example.com/billing/cancel",
  });

  return { customer, checkout };
}

export async function hasProAccess(externalCustomerId: string) {
  const access = await monetplane.checkEntitlement({
    externalCustomerId,
    featureKey: "pro_access",
    environment: "test",
  });
  return access.granted;
}
