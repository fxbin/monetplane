import { describe, expect, it } from "vitest";
import {
  createCreemProviderAdapter,
  normalizeCreemCatalogProduct,
} from "../../src/modules/providers/adapters/creem";
import type { ProviderConnectionContext } from "../../src/modules/providers/contract";

const connection: ProviderConnectionContext = {
  id: "pc_creem",
  applicationId: "app_creem",
  provider: "creem",
  mode: "test",
  metadata: {},
  credentials: {
    apiKey: "creem_test_key",
    webhookSecret: "creem_webhook_secret",
  },
};

function creemProduct(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "prod_123",
    object: "product",
    mode: "test",
    name: "Pro plan",
    description: "Pro",
    price: 1900,
    currency: "USD",
    billing_type: "recurring",
    billing_period: "every-month",
    status: "active",
    tax_category: "saas",
    tax_mode: "inclusive",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fetchReturning(
  payload: unknown,
  status = 200,
): {
  fetchImpl: typeof fetch;
  requests: Array<{ url: string; headers: Record<string, string> }>;
} {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("Creem getCatalogProduct (#155)", () => {
  it("fetches GET /v1/products/{id} from the mode-specific base URL with the server-side API key", async () => {
    const { fetchImpl, requests } = fetchReturning(creemProduct());
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test", live: "https://creem.live" },
    });

    const product = await adapter.getCatalogProduct?.(connection, {
      providerProductId: "prod_123",
    });

    expect(requests[0]?.url).toBe("https://creem.test/v1/products/prod_123");
    expect(requests[0]?.headers["x-api-key"]).toBe("creem_test_key");
    expect(product).toMatchObject({
      providerProductId: "prod_123",
      billingType: "recurring",
      amountMinor: 1900,
      currency: "USD",
      recurringInterval: "month",
      intervalCount: 1,
      mode: "test",
      status: "active",
      taxCategory: "saas",
    });
  });

  it("uses the production base for live connections and normalizes prod mode", async () => {
    const { fetchImpl, requests } = fetchReturning(
      creemProduct({ mode: "prod" }),
    );
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test", live: "https://creem.live" },
    });

    const product = await adapter.getCatalogProduct?.(
      { ...connection, mode: "live" },
      { providerProductId: "prod_123" },
    );

    expect(requests[0]?.url).toBe("https://creem.live/v1/products/prod_123");
    expect(product?.mode).toBe("live");
  });

  it("maps the fixed billing periods onto MonetPlane intervals", () => {
    expect(
      normalizeCreemCatalogProduct(
        creemProduct({
          billing_type: "onetime",
          billing_period: "once",
        }) as never,
      ),
    ).toMatchObject({
      billingType: "one_time",
      recurringInterval: null,
      intervalCount: null,
    });
    expect(
      normalizeCreemCatalogProduct(
        creemProduct({ billing_period: "every-year" }) as never,
      ),
    ).toMatchObject({ recurringInterval: "year", intervalCount: 1 });
    expect(
      normalizeCreemCatalogProduct(
        creemProduct({ billing_period: "every-three-months" }) as never,
      ),
    ).toMatchObject({ recurringInterval: "month", intervalCount: 3 });
    expect(
      normalizeCreemCatalogProduct(
        creemProduct({
          billing_period: "custom",
          recurring_interval: "week",
          recurring_interval_count: 2,
        }) as never,
      ),
    ).toMatchObject({ recurringInterval: "week", intervalCount: 2 });
  });

  it("accepts an omitted billing_period (Creem requires it only for recurring products)", () => {
    // One-time product without a period: normalizes to no interval and
    // can link against a one-time price (review round 2, F4).
    expect(
      normalizeCreemCatalogProduct(
        creemProduct({
          billing_type: "onetime",
          billing_period: undefined,
        }) as never,
      ),
    ).toMatchObject({
      billingType: "one_time",
      recurringInterval: null,
      intervalCount: null,
    });
    // Recurring product without a period: normalizes to no interval; the
    // comparison layer flags the missing interval as a mismatch rather
    // than the adapter guessing one.
    expect(
      normalizeCreemCatalogProduct(
        creemProduct({
          billing_type: "recurring",
          billing_period: undefined,
        }) as never,
      ),
    ).toMatchObject({
      billingType: "recurring",
      recurringInterval: null,
      intervalCount: null,
    });
  });

  it("normalizes sandbox/test modes and treats unknown values as unknown", () => {
    expect(
      normalizeCreemCatalogProduct(creemProduct({ mode: "sandbox" }) as never)
        .mode,
    ).toBe("test");
    expect(
      normalizeCreemCatalogProduct(creemProduct({ mode: "mystery" }) as never)
        .mode,
    ).toBe("unknown");
  });

  it("fails closed on values it cannot verify", () => {
    // Unknown billing type.
    expect(() =>
      normalizeCreemCatalogProduct(
        creemProduct({ billing_type: "paywhatyouwant" }) as never,
      ),
    ).toThrow(/missing id, billing_type, price, or currency/i);
    // Non-integer minor-unit amount.
    expect(() =>
      normalizeCreemCatalogProduct(creemProduct({ price: 19.5 }) as never),
    ).toThrow(/safe integer/i);
    // Missing currency.
    expect(() =>
      normalizeCreemCatalogProduct(
        creemProduct({ currency: undefined }) as never,
      ),
    ).toThrow(/missing id, billing_type, price, or currency/i);
    // Unsupported billing period (day-based).
    expect(() =>
      normalizeCreemCatalogProduct(
        creemProduct({ billing_period: "every-day" }) as never,
      ),
    ).toThrow(/unsupported billing period/i);
    // Custom period without a representable interval.
    expect(() =>
      normalizeCreemCatalogProduct(
        creemProduct({
          billing_period: "custom",
          recurring_interval: "day",
          recurring_interval_count: 1,
        }) as never,
      ),
    ).toThrow(/custom billing interval/i);
    // Missing id.
    expect(() =>
      normalizeCreemCatalogProduct(creemProduct({ id: "" }) as never),
    ).toThrow(/missing id, billing_type, price, or currency/i);
  });

  it("classifies provider 404s as deterministic rejections", async () => {
    const { fetchImpl } = fetchReturning({ message: "product not found" }, 404);
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test" },
    });

    await expect(
      adapter.getCatalogProduct?.(connection, { providerProductId: "prod_x" }),
    ).rejects.toThrow(/product not found/i);
  });
});

describe("Creem checkout catalog precedence (#155)", () => {
  const metadataConnection: ProviderConnectionContext = {
    ...connection,
    metadata: { catalog: { price_legacy: "prod_legacy" } },
  };

  async function checkoutWith(
    connection: ProviderConnectionContext,
    providerProductId: string | undefined,
  ) {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "ch_1",
          checkout_url: "https://checkout.creem.test/ch_1",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test" },
    });
    await adapter.createCheckout(connection, {
      applicationId: connection.applicationId,
      monetplaneOrderId: "ord_1",
      monetplaneCustomerId: "cus_1",
      billingMode: "one_time",
      currency: "USD",
      items: [
        {
          productId: "prod_mp",
          priceId: "price_legacy",
          quantity: 1,
          unitAmountMinor: 1900,
          providerProductId,
        },
      ],
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
    });
    return requestBody?.product_id;
  }

  it("prefers the runtime-resolved mapping over legacy metadata", async () => {
    await expect(checkoutWith(metadataConnection, "prod_mapped")).resolves.toBe(
      "prod_mapped",
    );
  });

  it("falls back to the legacy metadata catalog when no mapping is resolved", async () => {
    await expect(checkoutWith(metadataConnection, undefined)).resolves.toBe(
      "prod_legacy",
    );
  });
});
