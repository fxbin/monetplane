import { describe, expect, it } from "vitest";
import {
  ApiError,
  AuthorizationError,
  createMonetPlaneClient,
  InsufficientCreditsError,
  MalformedResponseError,
  NetworkError,
} from "../../src/sdk/index";

function createFakeFetch(
  responses: Array<{
    match: (url: string) => boolean;
    status: number;
    body: unknown;
  }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    for (const r of responses) {
      if (r.match(url)) {
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("MonetPlane SDK", () => {
  describe("createMonetPlaneClient", () => {
    it("rejects when appSecret is missing", () => {
      expect(() =>
        createMonetPlaneClient({
          baseUrl: "https://api.test",
          appSecret: "",
        }),
      ).toThrow("appSecret is required");
    });

    it("rejects when baseUrl is empty", () => {
      expect(() =>
        createMonetPlaneClient({
          baseUrl: "",
          appSecret: "mp_app_test",
        }),
      ).toThrow("baseUrl is required");
    });
  });

  describe("upsertCustomer", () => {
    it("returns the customer object on success", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.endsWith("/api/customers"),
          status: 201,
          body: {
            id: "acus_1",
            applicationId: "app_1",
            customerId: "cus_1",
            externalCustomerId: "user-1",
            email: "user@test.com",
            metadata: {},
          },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const result = await client.upsertCustomer({
        externalCustomerId: "user-1",
        email: "user@test.com",
      });

      expect(result.id).toBe("acus_1");
      expect(result.externalCustomerId).toBe("user-1");
    });
  });

  describe("createCheckout", () => {
    it("returns the checkout result on success", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.endsWith("/api/checkout"),
          status: 201,
          body: {
            orderId: "ord_1",
            checkoutSessionId: "chk_1",
            checkoutUrl: "https://checkout.test/ord_1",
            providerCheckoutId: "pc_1",
            orderStatus: "pending",
          },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const result = await client.createCheckout({
        externalCustomerId: "user-1",
        items: [{ priceId: "price_1", quantity: 1 }],
        providerConnectionId: "pc_1",
        successUrl: "https://app.test/success",
        cancelUrl: "https://app.test/cancel",
      });

      expect(result.orderId).toBe("ord_1");
      expect(result.checkoutUrl).toBe("https://checkout.test/ord_1");
    });
  });

  describe("getCreditBalance", () => {
    it("returns balance on success", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.endsWith("/api/credits/balance"),
          status: 200,
          body: {
            creditType: "agent.run",
            available: 500,
            reserved: 100,
          },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const result = await client.getCreditBalance("user-1", "agent.run");

      expect(result.available).toBe(500);
      expect(result.reserved).toBe(100);
    });
  });

  describe("debitCredits", () => {
    it("returns transaction on success", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.endsWith("/api/credits/debit"),
          status: 200,
          body: {
            transactionId: "ctx_1",
            duplicate: false,
            availableAfter: 400,
          },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const result = await client.debitCredits({
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 100,
        sourceType: "job",
        sourceId: "job_1",
        idempotencyKey: "debit-1",
      });

      expect(result.transactionId).toBe("ctx_1");
      expect(result.duplicate).toBe(false);
    });

    it("throws InsufficientCreditsError on 402", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.endsWith("/api/credits/debit"),
          status: 402,
          body: {
            error: "Insufficient available credits",
            code: "insufficient_credits",
          },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      await expect(
        client.debitCredits({
          externalCustomerId: "user-1",
          creditType: "agent.run",
          amount: 999,
          sourceType: "job",
          sourceId: "job_1",
          idempotencyKey: "debit-2",
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError);
    });
  });

  describe("reserveCredits + captureReservation + releaseReservation", () => {
    it("reserves, captures, and releases correctly", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.endsWith("/api/credits/reserve"),
          status: 200,
          body: { reservationId: "cres_1", duplicate: false },
        },
        {
          match: (u) => u.endsWith("/api/credits/capture"),
          status: 200,
          body: { transactionId: "ctx_2", duplicate: false, terminal: false },
        },
        {
          match: (u) => u.endsWith("/api/credits/release"),
          status: 200,
          body: { transactionId: "ctx_3", duplicate: false },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const reserve = await client.reserveCredits({
        externalCustomerId: "user-1",
        creditType: "agent.run",
        amount: 200,
        referenceType: "job",
        referenceId: "job_1",
        idempotencyKey: "reserve-1",
      });
      expect(reserve.reservationId).toBe("cres_1");

      const capture = await client.captureReservation({
        reservationId: "cres_1",
        amount: 150,
        idempotencyKey: "capture-1",
      });
      expect(capture.transactionId).toBe("ctx_2");

      const release = await client.releaseReservation({
        reservationId: "cres_2",
        idempotencyKey: "release-1",
      });
      expect(release.transactionId).toBe("ctx_3");
    });
  });

  describe("checkEntitlement", () => {
    it("returns granted boolean", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.endsWith("/api/entitlements/check"),
          status: 200,
          body: { granted: true },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const result = await client.checkEntitlement({
        externalCustomerId: "user-1",
        featureKey: "premium.features",
      });

      expect(result.granted).toBe(true);
    });
  });

  describe("createCustomerReadToken", () => {
    it("issues a token and posts the credential-authenticated route", async () => {
      const seen: { request?: { url: string; init?: RequestInit } } = {};
      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        seen.request = { url: String(input), init };
        return new Response(
          JSON.stringify({
            id: "crt_1",
            token: "mprt_raw",
            expiresAt: "2026-10-04T12:00:00.000Z",
            externalCustomerId: "user-1",
            environment: "test",
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch;

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const result = await client.createCustomerReadToken({
        externalCustomerId: "user-1",
        ttlSeconds: 300,
      });

      expect(result.token).toMatch(/^mprt_/);
      expect(result.expiresAt).toBe("2026-10-04T12:00:00.000Z");
      expect(seen.request?.url).toBe(
        "https://api.test/api/customer-read-tokens",
      );
      expect(seen.request?.init?.method).toBe("POST");
      expect(
        (seen.request?.init?.headers as Record<string, string>).authorization,
      ).toBe("Bearer mp_app_test");
      expect(JSON.parse(String(seen.request?.init?.body))).toEqual({
        externalCustomerId: "user-1",
        environment: undefined,
        ttlSeconds: 300,
      });
    });
  });

  describe("revokeCustomerReadToken", () => {
    it("DELETEs the token route and reports revocation", async () => {
      const seen: { request?: { url: string; init?: RequestInit } } = {};
      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        seen.request = { url: String(input), init };
        return new Response(JSON.stringify({ revoked: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const result = await client.revokeCustomerReadToken("crt_1");
      expect(result.revoked).toBe(true);
      expect(seen.request?.url).toBe(
        "https://api.test/api/customer-read-tokens/crt_1",
      );
      expect(seen.request?.init?.method).toBe("DELETE");
      expect(seen.request?.init?.body).toBeUndefined();
    });

    it("encodes the tokenId path segment", async () => {
      const seen: { url?: string } = {};
      const fetchImpl = (async (input: RequestInfo | URL) => {
        seen.url = String(input);
        return new Response(JSON.stringify({ revoked: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      await client.revokeCustomerReadToken("crt/a b");
      expect(seen.url).toBe(
        "https://api.test/api/customer-read-tokens/crt%2Fa%20b",
      );
    });

    it("throws ApiError (404) when the token is unknown or already revoked", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.includes("/api/customer-read-tokens/"),
          status: 404,
          body: {
            error: "Read token not found or already revoked",
            code: "not_found",
          },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      const error = await client
        .revokeCustomerReadToken("crt_gone")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(404);
      expect((error as ApiError).code).toBe("not_found");
    });
  });

  describe("error handling", () => {
    it("throws AuthorizationError on 401", async () => {
      const fetchImpl = createFakeFetch([
        {
          match: (u) => u.endsWith("/api/customers"),
          status: 401,
          body: {
            error: "Invalid application credential",
            code: "unauthorized",
          },
        },
      ]);

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      await expect(
        client.upsertCustomer({ externalCustomerId: "user-1" }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("throws NetworkError on fetch failure", async () => {
      const fetchImpl = (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch;

      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
        fetchImpl,
      });

      await expect(
        client.upsertCustomer({ externalCustomerId: "user-1" }),
      ).rejects.toBeInstanceOf(NetworkError);
    });
  });

  describe("provider neutrality", () => {
    it("SDK public API does not expose provider-specific types", () => {
      const client = createMonetPlaneClient({
        baseUrl: "https://api.test",
        appSecret: "mp_app_test",
      });

      // Verify the client only has provider-neutral methods
      const methods = Object.keys(client).sort();
      expect(methods).toEqual([
        "captureReservation",
        "checkEntitlement",
        "createCheckout",
        "createCustomerPortalSession",
        "createCustomerReadToken",
        "debitCredits",
        "getCreditBalance",
        "releaseReservation",
        "reportUsage",
        "reserveCredits",
        "revokeCustomerReadToken",
        "upsertCustomer",
      ]);
    });
  });

  describe("money-field runtime guards (roundtable batch 2)", () => {
    it("returns a balance unchanged when the money shape is valid", async () => {
      const client = createMonetPlaneClient({
        baseUrl: "https://monetplane.test",
        appSecret: "mp_app_secret_test_000000000000",
        fetchImpl: createFakeFetch([
          {
            match: (url) => url.endsWith("/api/credits/balance"),
            status: 200,
            body: { creditType: "generation", available: 100, reserved: 20 },
          },
        ]),
      });
      await expect(
        client.getCreditBalance("user-1", "generation"),
      ).resolves.toEqual({
        creditType: "generation",
        available: 100,
        reserved: 20,
      });
    });

    it("fails fast when a balance field is not a safe integer", async () => {
      const client = createMonetPlaneClient({
        baseUrl: "https://monetplane.test",
        appSecret: "mp_app_secret_test_000000000000",
        fetchImpl: createFakeFetch([
          {
            match: (url) => url.endsWith("/api/credits/balance"),
            status: 200,
            body: { creditType: "generation", available: "100", reserved: 20 },
          },
        ]),
      });
      await expect(
        client.getCreditBalance("user-1", "generation"),
      ).rejects.toBeInstanceOf(MalformedResponseError);
    });

    it("fails fast when a debit result reports a non-integer balance", async () => {
      const client = createMonetPlaneClient({
        baseUrl: "https://monetplane.test",
        appSecret: "mp_app_secret_test_000000000000",
        fetchImpl: createFakeFetch([
          {
            match: (url) => url.endsWith("/api/credits/debit"),
            status: 200,
            body: {
              transactionId: "ct_1",
              duplicate: false,
              availableAfter: 12.5,
            },
          },
        ]),
      });
      await expect(
        client.debitCredits({
          externalCustomerId: "user-1",
          creditType: "generation",
          amount: 5,
          sourceType: "test",
          sourceId: "sdk-guard",
          idempotencyKey: "k1",
        }),
      ).rejects.toBeInstanceOf(MalformedResponseError);
    });
  });
});
