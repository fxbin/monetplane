import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  createMonetPlaneClient,
  InsufficientCreditsError,
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
        "debitCredits",
        "getCreditBalance",
        "releaseReservation",
        "reserveCredits",
        "upsertCustomer",
      ]);
    });
  });
});
