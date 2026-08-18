import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import { prices } from "../../src/modules/catalog/schema";
import {
  addProductGrantConfig,
  createPrice,
  createProduct,
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

describe("product and price catalog", () => {
  it("supports monthly and annual prices for one product", async () => {
    const app = await createApplication(
      { slug: "pricing", name: "Pricing" },
      db,
    );
    const product = await createProduct(
      { applicationId: app.id, key: "pro", name: "Pro" },
      db,
    );

    const monthly = await createPrice(
      {
        applicationId: app.id,
        productId: product.id,
        key: "monthly",
        currency: "usd",
        amountMinor: 1900,
        billingType: "recurring",
        recurringInterval: "month",
      },
      db,
    );
    const annual = await createPrice(
      {
        applicationId: app.id,
        productId: product.id,
        key: "annual",
        currency: "USD",
        amountMinor: 19000,
        billingType: "recurring",
        recurringInterval: "year",
      },
      db,
    );

    expect(monthly.amountMinor).toBe(1900);
    expect(monthly.currency).toBe("USD");
    expect(monthly.recurringInterval).toBe("month");
    expect(annual.recurringInterval).toBe("year");
    expect(monthly).not.toHaveProperty("provider");
    expect(annual).not.toHaveProperty("providerPriceId");
  });

  it("uses the same model for one-time prices", async () => {
    const app = await createApplication({ slug: "mixed", name: "Mixed" }, db);
    const product = await createProduct(
      { applicationId: app.id, key: "credits-500", name: "500 Credits" },
      db,
    );

    const oneTime = await createPrice(
      {
        applicationId: app.id,
        productId: product.id,
        key: "top-up",
        currency: "USD",
        amountMinor: 999,
        billingType: "one_time",
      },
      db,
    );

    expect(oneTime.billingType).toBe("one_time");
    expect(oneTime.recurringInterval).toBeNull();
    expect(oneTime.intervalCount).toBeNull();
  });

  it("rejects invalid billing shapes and non-integer money", async () => {
    const app = await createApplication(
      { slug: "validation", name: "Validation" },
      db,
    );
    const product = await createProduct(
      { applicationId: app.id, key: "pro", name: "Pro" },
      db,
    );

    await expect(
      createPrice(
        {
          applicationId: app.id,
          productId: product.id,
          key: "bad-recurring",
          currency: "USD",
          amountMinor: 1000,
          billingType: "recurring",
        },
        db,
      ),
    ).rejects.toThrow("month or year");

    await expect(
      createPrice(
        {
          applicationId: app.id,
          productId: product.id,
          key: "fractional",
          currency: "USD",
          amountMinor: 10.5,
          billingType: "one_time",
        },
        db,
      ),
    ).rejects.toThrow("minor units");
  });

  it("also enforces money constraints in PostgreSQL", async () => {
    const app = await createApplication(
      { slug: "db-guard", name: "DB Guard" },
      db,
    );
    const product = await createProduct(
      { applicationId: app.id, key: "guarded", name: "Guarded" },
      db,
    );

    await expect(
      db.insert(prices).values({
        id: "price_invalid_negative",
        productId: product.id,
        key: "invalid-negative",
        currency: "USD",
        amountMinor: -1,
        billingType: "one_time",
        recurringInterval: null,
        intervalCount: null,
        metadata: {},
      }),
    ).rejects.toThrow();
  });

  it("keeps catalog reads application-isolated", async () => {
    const firstApp = await createApplication(
      { slug: "catalog-a", name: "Catalog A" },
      db,
    );
    const secondApp = await createApplication(
      { slug: "catalog-b", name: "Catalog B" },
      db,
    );

    await createProduct(
      { applicationId: firstApp.id, key: "first-pro", name: "First Pro" },
      db,
    );
    await createProduct(
      { applicationId: secondApp.id, key: "second-pro", name: "Second Pro" },
      db,
    );

    const firstCatalog = await listApplicationCatalog(firstApp.id, db);
    const secondCatalog = await listApplicationCatalog(secondApp.id, db);

    expect(firstCatalog).toHaveLength(1);
    expect(firstCatalog[0]?.product.key).toBe("first-pro");
    expect(secondCatalog).toHaveLength(1);
    expect(secondCatalog[0]?.product.key).toBe("second-pro");
  });

  it("stores entitlement and credit grant references", async () => {
    const app = await createApplication(
      { slug: "benefits", name: "Benefits" },
      db,
    );
    const product = await createProduct(
      { applicationId: app.id, key: "pro", name: "Pro" },
      db,
    );

    const entitlement = await addProductGrantConfig(
      {
        applicationId: app.id,
        productId: product.id,
        grantType: "entitlement",
        referenceKey: "advanced-agent-lab",
      },
      db,
    );
    const credits = await addProductGrantConfig(
      {
        applicationId: app.id,
        productId: product.id,
        grantType: "credit",
        referenceKey: "ai-credits",
        quantity: 500,
      },
      db,
    );

    expect(entitlement.quantity).toBeNull();
    expect(credits.quantity).toBe(500);
    expect(credits).not.toHaveProperty("provider");
  });
});
