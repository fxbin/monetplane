import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import {
  createConfiguredProduct,
  listApplicationCatalog,
} from "../../src/modules/catalog/service";
import { customers } from "../../src/modules/customers/schema";

const db = getDb();

beforeEach(async () => {
  await db.delete(applications);
  await db.delete(customers);
});

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

describe("configured product creation", () => {
  it("creates product, price, credits, and entitlements as one catalog operation", async () => {
    const app = await createApplication(
      { slug: "builder", name: "Builder" },
      db,
    );

    const created = await createConfiguredProduct(
      {
        applicationId: app.id,
        key: "pro",
        name: "Pro",
        metadata: {
          monetplane: {
            productType: "subscription",
            providerRouting: { test: "pconn_example" },
          },
        },
        price: {
          key: "monthly",
          currency: "USD",
          amountMinor: 1900,
          billingType: "recurring",
          recurringInterval: "month",
          metadata: { role: "primary" },
        },
        grants: [
          {
            grantType: "credit",
            referenceKey: "generation",
            quantity: 500,
          },
          {
            grantType: "entitlement",
            referenceKey: "export.hd",
          },
        ],
      },
      db,
    );

    expect(created.product.key).toBe("pro");
    expect(created.price.amountMinor).toBe(1900);
    expect(created.grants).toHaveLength(2);

    const catalog = await listApplicationCatalog(app.id, db);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.prices).toHaveLength(1);
    expect(catalog[0]?.grants).toHaveLength(2);
  });

  it("rolls the product back when primary price validation fails", async () => {
    const app = await createApplication(
      { slug: "builder-rollback", name: "Builder Rollback" },
      db,
    );

    await expect(
      createConfiguredProduct(
        {
          applicationId: app.id,
          key: "broken",
          name: "Broken",
          price: {
            key: "default",
            currency: "USD",
            amountMinor: 10.5,
            billingType: "one_time",
          },
        },
        db,
      ),
    ).rejects.toThrow("minor units");

    const catalog = await listApplicationCatalog(app.id, db);
    expect(catalog).toHaveLength(0);
  });
});
