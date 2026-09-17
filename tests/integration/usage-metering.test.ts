import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  computeBillingQuantity,
  createUsageMeter,
  getUsageSummary,
  reportUsage,
  UsageMeterNotFoundError,
} from "../../src/modules/usage/service";

const db = getDb();

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

async function seed() {
  const slug = `usage-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1", email: "u@test" },
    db,
  );
  return app;
}

function period(): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    periodEnd: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ),
  };
}

describe("usage metering (#62)", () => {
  beforeEach(() => {});

  it("creates per-unit and included+overage meters with shape validation", async () => {
    const app = await seed();
    const perUnit = await createUsageMeter(
      {
        applicationId: app.id,
        key: "api.calls",
        name: "API calls",
        unit: "call",
        currency: "USD",
        billingScheme: "per_unit",
        perUnitAmountMinor: 3,
      },
      db,
    );
    expect(perUnit.billingScheme).toBe("per_unit");

    const overage = await createUsageMeter(
      {
        applicationId: app.id,
        key: "tokens",
        name: "Tokens",
        unit: "1k tokens",
        currency: "USD",
        billingScheme: "included_overage",
        includedQuantity: 1000,
        overageUnitAmountMinor: 5,
      },
      db,
    );
    expect(overage.includedQuantity).toBe(1000);

    await expect(
      createUsageMeter(
        {
          applicationId: app.id,
          key: "bad",
          name: "Bad",
          unit: "x",
          currency: "USD",
          billingScheme: "included_overage",
          includedQuantity: 10,
          // missing overage rate
        },
        db,
      ),
    ).rejects.toThrow(/included_overage/i);
  });

  it("ingests usage idempotently — duplicates and concurrency cannot double-bill", async () => {
    const app = await seed();
    await createUsageMeter(
      {
        applicationId: app.id,
        key: "api.calls",
        name: "API calls",
        unit: "call",
        currency: "USD",
        billingScheme: "per_unit",
        perUnitAmountMinor: 3,
      },
      db,
    );

    const first = await reportUsage(
      {
        applicationId: app.id,
        environment: "test",
        meterKey: "api.calls",
        externalCustomerId: "user-1",
        quantity: 10,
        sourceType: "app",
        sourceId: "job-1",
        idempotencyKey: "usage-key-1",
      },
      db,
    );
    expect(first.duplicate).toBe(false);

    const replay = await reportUsage(
      {
        applicationId: app.id,
        environment: "test",
        meterKey: "api.calls",
        externalCustomerId: "user-1",
        quantity: 10,
        sourceType: "app",
        sourceId: "job-1",
        idempotencyKey: "usage-key-1",
      },
      db,
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.event.id).toBe(first.event.id);

    // Concurrent duplicate reports resolve to a single row.
    const concurrent = await Promise.all(
      [1, 2, 3].map((i) =>
        reportUsage(
          {
            applicationId: app.id,
            environment: "test",
            meterKey: "api.calls",
            externalCustomerId: "user-1",
            quantity: 7,
            sourceType: "app",
            sourceId: `race-${i}`,
            idempotencyKey: "usage-race",
          },
          db,
        ),
      ),
    );
    expect(concurrent.filter((r) => !r.duplicate)).toHaveLength(1);

    const { periodStart, periodEnd } = period();
    const summary = await getUsageSummary(
      {
        applicationId: app.id,
        environment: "test",
        meterKey: "api.calls",
        periodStart,
        periodEnd,
      },
      db,
    );
    expect(summary.measuredQuantity).toBe(17); // 10 + 7 once
    expect(summary.amountMinor).toBe(51);
  });

  it("isolates usage by environment and application", async () => {
    const app = await seed();
    const other = await seed();
    await createUsageMeter(
      {
        applicationId: app.id,
        key: "api.calls",
        name: "API calls",
        unit: "call",
        currency: "USD",
        billingScheme: "per_unit",
        perUnitAmountMinor: 2,
      },
      db,
    );
    await createUsageMeter(
      {
        applicationId: other.id,
        key: "api.calls",
        name: "API calls",
        unit: "call",
        currency: "USD",
        billingScheme: "per_unit",
        perUnitAmountMinor: 2,
      },
      db,
    );

    await reportUsage(
      {
        applicationId: app.id,
        environment: "test",
        meterKey: "api.calls",
        externalCustomerId: "user-1",
        quantity: 5,
        sourceType: "app",
        sourceId: "s1",
        idempotencyKey: "iso-test",
      },
      db,
    );
    // Same app + same key in live is a separate event.
    await reportUsage(
      {
        applicationId: app.id,
        environment: "live",
        meterKey: "api.calls",
        externalCustomerId: "user-1",
        quantity: 9,
        sourceType: "app",
        sourceId: "s1",
        idempotencyKey: "iso-test",
      },
      db,
    );

    const { periodStart, periodEnd } = period();
    const testSummary = await getUsageSummary(
      {
        applicationId: app.id,
        environment: "test",
        meterKey: "api.calls",
        periodStart,
        periodEnd,
      },
      db,
    );
    const liveSummary = await getUsageSummary(
      {
        applicationId: app.id,
        environment: "live",
        meterKey: "api.calls",
        periodStart,
        periodEnd,
      },
      db,
    );
    const otherSummary = await getUsageSummary(
      {
        applicationId: other.id,
        environment: "test",
        meterKey: "api.calls",
        periodStart,
        periodEnd,
      },
      db,
    );
    expect(testSummary.measuredQuantity).toBe(5);
    expect(liveSummary.measuredQuantity).toBe(9);
    expect(otherSummary.measuredQuantity).toBe(0);
  });

  it("computes deterministic period billing quantities with allowance and overage", async () => {
    const app = await seed();
    await createUsageMeter(
      {
        applicationId: app.id,
        key: "tokens",
        name: "Tokens",
        unit: "1k tokens",
        currency: "USD",
        billingScheme: "included_overage",
        includedQuantity: 1000,
        overageUnitAmountMinor: 5,
      },
      db,
    );

    await reportUsage(
      {
        applicationId: app.id,
        environment: "test",
        meterKey: "tokens",
        externalCustomerId: "user-1",
        quantity: 400,
        sourceType: "app",
        sourceId: "s1",
        idempotencyKey: "tok-1",
        occurredAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      },
      db,
    );
    await reportUsage(
      {
        applicationId: app.id,
        environment: "test",
        meterKey: "tokens",
        externalCustomerId: "user-1",
        quantity: 800,
        sourceType: "app",
        sourceId: "s2",
        idempotencyKey: "tok-2",
      },
      db,
    );

    const { periodStart, periodEnd } = period();
    const summary = await getUsageSummary(
      {
        applicationId: app.id,
        environment: "test",
        meterKey: "tokens",
        externalCustomerId: "user-1",
        periodStart,
        periodEnd,
      },
      db,
    );
    expect(summary.measuredQuantity).toBe(1200);
    expect(summary.includedQuantity).toBe(1000);
    expect(summary.overageQuantity).toBe(200);
    expect(summary.amountMinor).toBe(1000); // 200 * 5

    // Pure unit math coverage.
    expect(
      computeBillingQuantity(
        {
          billingScheme: "per_unit",
          includedQuantity: null,
          perUnitAmountMinor: 3,
          overageUnitAmountMinor: null,
        },
        10,
      ),
    ).toEqual({
      billingQuantity: 10,
      includedQuantity: 0,
      overageQuantity: 0,
      amountMinor: 30,
    });
    expect(
      computeBillingQuantity(
        {
          billingScheme: "included_overage",
          includedQuantity: 500,
          perUnitAmountMinor: null,
          overageUnitAmountMinor: 7,
        },
        300,
      ),
    ).toEqual({
      billingQuantity: 0,
      includedQuantity: 300,
      overageQuantity: 0,
      amountMinor: 0,
    });
  });

  it("rejects unknown meters with a typed error", async () => {
    const app = await seed();
    await expect(
      reportUsage(
        {
          applicationId: app.id,
          environment: "test",
          meterKey: "missing",
          externalCustomerId: "user-1",
          quantity: 1,
          sourceType: "app",
          sourceId: "s",
          idempotencyKey: "k",
        },
        db,
      ),
    ).rejects.toThrow(UsageMeterNotFoundError);
  });
});
