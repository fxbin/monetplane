import { describe, expect, it } from "vitest";
import {
  createCreemProviderAdapter,
  creemBillingPeriodFromBody,
} from "../../src/modules/providers/adapters/creem";
import { classifyHttpFailure } from "../../src/modules/providers/adapters/shared";
import type { ProviderConnectionContext } from "../../src/modules/providers/contract";
import { ProviderOperationError } from "../../src/modules/providers/contract";

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

function createInput(
  overrides: Record<string, unknown> = {},
): Parameters<
  NonNullable<
    ReturnType<typeof createCreemProviderAdapter>["createCatalogProduct"]
  >
>[1] {
  return {
    name: "Pro plan",
    description: "All the pro features",
    amountMinor: 1900,
    currency: "USD",
    billingType: "one_time",
    recurringInterval: null,
    intervalCount: null,
    taxCategory: null,
    idempotencyKey: "pcmap_test_key",
    ...overrides,
  } as never;
}

function fetchCapturing(
  payload: unknown,
  status = 200,
): {
  fetchImpl: typeof fetch;
  requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }>;
} {
  const requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("creemBillingPeriodFromBody (#156)", () => {
  it("maps MonetPlane intervals onto fixed and custom Creem periods", () => {
    expect(
      creemBillingPeriodFromBody({
        billingType: "one_time",
        recurringInterval: null,
        intervalCount: null,
      }),
    ).toEqual({});
    expect(
      creemBillingPeriodFromBody({
        billingType: "recurring",
        recurringInterval: "month",
        intervalCount: 1,
      }),
    ).toEqual({ billing_period: "every-month" });
    expect(
      creemBillingPeriodFromBody({
        billingType: "recurring",
        recurringInterval: "year",
        intervalCount: 1,
      }),
    ).toEqual({ billing_period: "every-year" });
    expect(
      creemBillingPeriodFromBody({
        billingType: "recurring",
        recurringInterval: "month",
        intervalCount: 3,
      }),
    ).toEqual({ billing_period: "every-three-months" });
    expect(
      creemBillingPeriodFromBody({
        billingType: "recurring",
        recurringInterval: "week",
        intervalCount: 2,
      }),
    ).toEqual({
      billing_period: "custom",
      recurring_interval: "week",
      recurring_interval_count: 2,
    });
  });

  it("fails closed when a recurring create lacks the interval", () => {
    expect(() =>
      creemBillingPeriodFromBody({
        billingType: "recurring",
        recurringInterval: null,
        intervalCount: null,
      }),
    ).toThrow(/billing interval and count/i);
  });
});

describe("Creem createCatalogProduct (#156)", () => {
  it("POSTs /v1/products to the mode-specific base URL with the idempotency key", async () => {
    const { fetchImpl, requests } = fetchCapturing({ id: "prod_new" });
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test", live: "https://creem.live" },
    });

    const result = await adapter.createCatalogProduct?.(
      connection,
      createInput(),
    );

    expect(result).toEqual({ providerProductId: "prod_new" });
    expect(requests[0]?.url).toBe("https://creem.test/v1/products");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers["x-api-key"]).toBe("creem_test_key");
    expect(requests[0]?.headers["idempotency-key"]).toBe("pcmap_test_key");
    expect(requests[0]?.body).toEqual({
      name: "Pro plan",
      description: "All the pro features",
      price: 1900,
      currency: "USD",
      billing_type: "onetime",
    });
  });

  it("maps recurring fields and tax category into the request body", async () => {
    const { fetchImpl, requests } = fetchCapturing({ id: "prod_new" });
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test" },
    });

    await adapter.createCatalogProduct?.(
      connection,
      createInput({
        billingType: "recurring",
        recurringInterval: "month",
        intervalCount: 1,
        taxCategory: "saas",
      }),
    );

    expect(requests[0]?.body).toMatchObject({
      billing_type: "recurring",
      billing_period: "every-month",
      tax_category: "saas",
    });
  });

  it("uses the production base for live connections", async () => {
    const { fetchImpl, requests } = fetchCapturing({ id: "prod_new" });
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test", live: "https://creem.live" },
    });
    await adapter.createCatalogProduct?.(
      { ...connection, mode: "live" },
      createInput(),
    );
    expect(requests[0]?.url).toBe("https://creem.live/v1/products");
  });

  it("fails closed before any request on Creem-side constraint violations", async () => {
    const { fetchImpl, requests } = fetchCapturing({ id: "prod_new" });
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test" },
    });

    await expect(
      adapter.createCatalogProduct?.(
        connection,
        createInput({ currency: "JPY" }),
      ),
    ).rejects.toThrow(/only supports/i);
    await expect(
      adapter.createCatalogProduct?.(
        connection,
        createInput({ amountMinor: 50 }),
      ),
    ).rejects.toThrow(/at least 100 minor units/i);
    await expect(
      adapter.createCatalogProduct?.(
        connection,
        createInput({ taxCategory: "physical-goods" }),
      ),
    ).rejects.toThrow(/tax category/i);
    await expect(
      adapter.createCatalogProduct?.(
        connection,
        createInput({ idempotencyKey: "  " }),
      ),
    ).rejects.toThrow(/idempotency key/i);

    // A free (0) product is legal.
    await expect(
      adapter.createCatalogProduct?.(
        connection,
        createInput({ amountMinor: 0 }),
      ),
    ).resolves.toEqual({ providerProductId: "prod_new" });
    // Four pre-flight rejections, one real request (the free create).
    expect(requests).toHaveLength(1);
  });

  it("rejects a create response without an id", async () => {
    const { fetchImpl } = fetchCapturing({ object: "product" });
    const adapter = createCreemProviderAdapter({
      fetchImpl,
      baseUrls: { test: "https://creem.test" },
    });
    await expect(
      adapter.createCatalogProduct?.(connection, createInput()),
    ).rejects.toThrow(/missing id/i);
  });

  it("exposes the HTTP status on classified failures (429 retry decisions)", () => {
    const rateLimited = classifyHttpFailure(
      429,
      "Creem request failed (429 Too Many Requests)",
    );
    expect(rateLimited).toBeInstanceOf(ProviderOperationError);
    expect(rateLimited.failureKind).toBe("rejected");
    expect(rateLimited.status).toBe(429);
    const serverError = classifyHttpFailure(503, "Creem request failed");
    expect(serverError.failureKind).toBe("outcome_uncertain");
    expect(serverError.status).toBe(503);
  });
});
