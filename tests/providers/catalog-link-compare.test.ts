import { describe, expect, it } from "vitest";
import { compareProviderProductWithPrice } from "../../src/modules/providers/catalog-mapping";
import type { NormalizedProviderCatalogProduct } from "../../src/modules/providers/contract";

function price(overrides: Record<string, unknown> = {}) {
  return {
    currency: "USD",
    amountMinor: 1900,
    billingType: "one_time",
    recurringInterval: null,
    intervalCount: null,
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    providerProductId: "prod_123",
    name: "Pro",
    status: "active",
    mode: "test",
    billingType: "one_time",
    amountMinor: 1900,
    currency: "USD",
    recurringInterval: null,
    intervalCount: null,
    taxCategory: "saas",
    ...overrides,
  } as NormalizedProviderCatalogProduct;
}

describe("compareProviderProductWithPrice (#155)", () => {
  it("accepts an exact one-time match", () => {
    expect(compareProviderProductWithPrice(price(), product(), "test")).toEqual(
      [],
    );
  });

  it("accepts an exact recurring match including interval count", () => {
    expect(
      compareProviderProductWithPrice(
        price({
          billingType: "recurring",
          recurringInterval: "month",
          intervalCount: 1,
        }),
        product({
          billingType: "recurring",
          recurringInterval: "month",
          intervalCount: 1,
        }),
        "test",
      ),
    ).toEqual([]);
  });

  it("rejects currency, amount, and billing-type divergence", () => {
    const mismatches = compareProviderProductWithPrice(
      price(),
      product({
        currency: "EUR",
        amountMinor: 2000,
        billingType: "recurring",
      }),
      "test",
    );
    expect(mismatches.map((m) => m.field)).toEqual([
      "currency",
      "amountMinor",
      "billingType",
    ]);
  });

  it("rejects interval and interval-count divergence on recurring prices", () => {
    const wrongInterval = compareProviderProductWithPrice(
      price({
        billingType: "recurring",
        recurringInterval: "month",
        intervalCount: 1,
      }),
      product({
        billingType: "recurring",
        recurringInterval: "year",
        intervalCount: 1,
      }),
      "test",
    );
    expect(wrongInterval.map((m) => m.field)).toEqual(["billingInterval"]);

    const wrongCount = compareProviderProductWithPrice(
      price({
        billingType: "recurring",
        recurringInterval: "month",
        intervalCount: 1,
      }),
      product({
        billingType: "recurring",
        recurringInterval: "month",
        intervalCount: 3,
      }),
      "test",
    );
    expect(wrongCount.map((m) => m.field)).toEqual(["billingInterval"]);
  });

  it("rejects a recurring price against a provider product with no interval (Creem omits billing_period for one-time products)", () => {
    const mismatches = compareProviderProductWithPrice(
      price({
        billingType: "recurring",
        recurringInterval: "month",
        intervalCount: 1,
      }),
      product({
        billingType: "recurring",
        recurringInterval: null,
        intervalCount: null,
      }),
      "test",
    );
    expect(mismatches.map((m) => m.field)).toEqual(["billingInterval"]);
  });

  it("rejects a recurring provider product for a one-time price", () => {
    const mismatches = compareProviderProductWithPrice(
      price(),
      product({
        billingType: "one_time",
        recurringInterval: "month",
        intervalCount: 1,
      }),
      "test",
    );
    expect(mismatches.map((m) => m.field)).toEqual(["billingInterval"]);
  });

  it("rejects environment and status divergence, including unknown values", () => {
    expect(
      compareProviderProductWithPrice(
        price(),
        product({ mode: "live" }),
        "test",
      ).map((m) => m.field),
    ).toEqual(["mode"]);
    expect(
      compareProviderProductWithPrice(
        price(),
        product({ mode: "unknown" }),
        "live",
      ).map((m) => m.field),
    ).toEqual(["mode"]);
    expect(
      compareProviderProductWithPrice(
        price(),
        product({ status: "archived" }),
        "test",
      ).map((m) => m.field),
    ).toEqual(["status"]);
    expect(
      compareProviderProductWithPrice(
        price(),
        product({ status: "unknown" }),
        "test",
      ).map((m) => m.field),
    ).toEqual(["status"]);
  });
});
