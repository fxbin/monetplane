import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import {
  ProviderApplicationMismatchError,
  UnsupportedProviderCapabilityError,
} from "../../src/modules/providers/contract";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import { createProviderCheckout } from "../../src/modules/providers/runtime";
import { createProviderConnection } from "../../src/modules/providers/service";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

const limitedAdapter = {
  ...mockProviderAdapter,
  provider: "limited",
  getCapabilities: () => ({
    one_time_checkout: false,
    recurring_subscription: false,
    monthly_interval: false,
    annual_interval: false,
    refund: false,
    subscription_cancel: false,
    subscription_update: false,
    customer_portal: false,
    provider_hosted_checkout: false,
  }),
};

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  clearProviderAdaptersForTests();
  registerProviderAdapter(limitedAdapter);
  await db.delete(applications);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

describe("provider runtime guards", () => {
  it("rejects unsupported capabilities instead of silently falling back", async () => {
    const app = await createApplication(
      { slug: "limited-provider", name: "Limited Provider" },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "limited",
        name: "primary",
        mode: "test",
        credentials: { webhookSecret: "limited-secret" },
      },
      db,
    );

    await expect(
      createProviderCheckout(
        app.id,
        connection.id,
        {
          applicationId: app.id,
          monetplaneOrderId: "ord_limited",
          monetplaneCustomerId: "cus_limited",
          billingMode: "one_time",
          currency: "USD",
          items: [
            {
              productId: "prod_limited",
              priceId: "price_limited",
              quantity: 1,
              unitAmountMinor: 100,
            },
          ],
          successUrl: "https://product.test/success",
          cancelUrl: "https://product.test/cancel",
        },
        db,
      ),
    ).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });

  it("rejects mismatched application context before provider invocation", async () => {
    await expect(
      createProviderCheckout(
        "app_trusted",
        "pconn_unused",
        {
          applicationId: "app_untrusted",
          monetplaneOrderId: "ord_mismatch",
          monetplaneCustomerId: "cus_mismatch",
          billingMode: "one_time",
          currency: "USD",
          items: [],
          successUrl: "https://product.test/success",
          cancelUrl: "https://product.test/cancel",
        },
        db,
      ),
    ).rejects.toBeInstanceOf(ProviderApplicationMismatchError);
  });
});
