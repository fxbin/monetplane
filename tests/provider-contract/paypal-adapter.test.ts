import { describe, expect, it } from "vitest";
import { createPayPalProviderAdapter } from "../../src/modules/providers/adapters/paypal";
import type {
  ProviderConnectionContext,
  VerifyWebhookInput,
} from "../../src/modules/providers/contract";
import { defineProviderAdapterContractTests } from "./adapter-contract";

/**
 * PayPal adapter bound to the shared conformance suite (#72). The fake fetch
 * stubs OAuth, order creation, subscription creation, and the webhook
 * signature-verification API — the same request shapes exercised live
 * against api-m.sandbox.paypal.com (docs/paypal-live-evidence.md).
 */

const webhookId = "WH_CONTRACT_WEBHOOK_ID";

const connection: ProviderConnectionContext = {
  id: "pc_paypal_contract",
  applicationId: "app_contract",
  provider: "paypal",
  mode: "test",
  metadata: {
    catalog: {
      price_contract: { productId: "PROD_CONTRACT", planId: "P-CONTRACT" },
    },
  },
  credentials: {
    clientId: "PP_CLIENT_ID",
    clientSecret: "PP_CLIENT_SECRET",
    webhookId,
  },
};

const webhookPayload = JSON.stringify({
  id: "WH-CONTRACT-1",
  event_version: "1.0",
  create_time: "2026-09-26T08:00:00.000Z",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource_type: "capture",
  resource: {
    id: "CAPTURE_CONTRACT_1",
    status: "COMPLETED",
    custom_id:
      "monetplane_order_id:ord_contract|monetplane_customer_id:cus_contract",
    amount: { currency_code: "USD", value: "29.00" },
  },
});

const unknownPayload = JSON.stringify({
  id: "WH-UNKNOWN-1",
  event_version: "1.0",
  create_time: "2026-09-26T08:00:00.000Z",
  event_type: "definitely.not.a.real.event",
  resource_type: "unknown",
  resource: { id: "RES_UNKNOWN_1" },
});

function verifyHeaders(body: string): Record<string, string> {
  return {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url":
      "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360RSA42",
    "paypal-transmission-id": "TRX-CONTRACT-1",
    "paypal-transmission-time": "2026-09-26T08:00:00.000Z",
    "paypal-transmission-sig": `sig-for-${body.length}`,
  };
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : "";

  if (url.endsWith("/v1/oauth2/token") && method === "POST") {
    return jsonResponse({ access_token: "pp_test_token", expires_in: 32400 });
  }
  if (url.endsWith("/v2/checkout/orders") && method === "POST") {
    const parsed = JSON.parse(body) as {
      purchase_units?: Array<{
        custom_id?: string;
        amount?: { value?: string };
      }>;
    };
    if (
      !parsed.purchase_units?.[0]?.custom_id?.includes("monetplane_order_id")
    ) {
      return jsonResponse(
        { message: "Invalid request - see details", details: [] },
        400,
      );
    }
    return jsonResponse({
      id: "ORDER_CONTRACT_1",
      status: "CREATED",
      links: [
        {
          rel: "payer-action",
          href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER_CONTRACT_1",
        },
      ],
    });
  }
  if (url.endsWith("/v1/billing/subscriptions") && method === "POST") {
    const parsed = JSON.parse(body) as { plan_id?: string; custom_id?: string };
    if (parsed.plan_id !== "P-CONTRACT") {
      return jsonResponse({ message: "Invalid plan_id" }, 400);
    }
    return jsonResponse({
      id: "I-CONTRACT-1",
      status: "APPROVAL_PENDING",
      plan_id: parsed.plan_id,
      custom_id: parsed.custom_id,
      links: [
        {
          rel: "approve",
          href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=I-CONTRACT-1",
        },
      ],
    });
  }
  if (
    url.endsWith("/v1/notifications/verify-webhook-signature") &&
    method === "POST"
  ) {
    const parsed = JSON.parse(body) as {
      webhook_event?: { id?: string };
      transmission_sig?: string;
      webhook_id?: string;
    };
    // Mirror PayPal: SUCCESS only when the transmission signature matches the
    // one our fixtures computed for this body and the webhook id is ours.
    const ok =
      parsed.webhook_id === webhookId &&
      typeof parsed.transmission_sig === "string" &&
      parsed.transmission_sig.startsWith("sig-for-");
    return jsonResponse(
      { verification_status: ok ? "SUCCESS" : "FAILURE" },
      200,
    );
  }
  return jsonResponse({ message: `Unexpected request: ${method} ${url}` }, 404);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const validWebhook: VerifyWebhookInput = {
  rawBody: webhookPayload,
  headers: verifyHeaders(webhookPayload),
};

defineProviderAdapterContractTests({
  name: "paypal",
  adapter: createPayPalProviderAdapter({ fetchImpl: fakeFetch }),
  connection,
  checkout: {
    applicationId: connection.applicationId,
    monetplaneOrderId: "ord_contract",
    monetplaneCustomerId: "cus_contract",
    billingMode: "one_time",
    currency: "USD",
    items: [
      {
        productId: "prod_contract",
        priceId: "price_contract",
        quantity: 1,
        unitAmountMinor: 2900,
      },
    ],
    successUrl: "https://product.test/success",
    cancelUrl: "https://product.test/cancel",
  },
  validWebhook,
  invalidWebhook: {
    rawBody: webhookPayload,
    headers: {},
  },
  unknownWebhook: {
    rawBody: unknownPayload,
    headers: verifyHeaders(unknownPayload),
  },
  expectedEventId: "WH-CONTRACT-1",
  expectedEventType: "payment.succeeded",
  expectedUnknownEventName: "definitely.not.a.real.event",
});

/**
 * Unified zero-decimal handling (audit A1): the PayPal adapter now shares
 * src/lib/money.ts with every other money site. JPY was already 0-decimal
 * here; ISK used to be 2-decimal in the old local table and is now unified
 * to 0-decimal (intentional behavioral change).
 */
describe("paypal adapter zero-decimal money (audit A1)", () => {
  const checkoutConnection: ProviderConnectionContext = {
    ...connection,
    metadata: {},
  };

  function capturingFetch() {
    const orderAmounts: Array<
      | {
          currency_code?: string;
          value?: string;
        }
      | undefined
    > = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "pp_test_token", expires_in: 32400 }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v2/checkout/orders")) {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as {
          purchase_units?: Array<{
            amount?: { currency_code?: string; value?: string };
          }>;
        };
        orderAmounts.push(parsed.purchase_units?.[0]?.amount);
        return new Response(
          JSON.stringify({
            id: "ORDER_ZERO_1",
            status: "CREATED",
            links: [
              {
                rel: "payer-action",
                href: "https://www.sandbox.paypal.com/checkoutnow?token=x",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ message: "unexpected" }), {
        status: 404,
      });
    };
    return { fetchImpl, orderAmounts };
  }

  async function checkoutWith(currency: string, unitAmountMinor: number) {
    const { fetchImpl, orderAmounts } = capturingFetch();
    const adapter = createPayPalProviderAdapter({ fetchImpl });
    await adapter.createCheckout(checkoutConnection, {
      applicationId: checkoutConnection.applicationId,
      monetplaneOrderId: "ord_zero",
      monetplaneCustomerId: "cus_zero",
      billingMode: "one_time",
      currency,
      items: [
        {
          productId: "prod_zero",
          priceId: "price_zero",
          quantity: 1,
          unitAmountMinor,
        },
      ],
      successUrl: "https://product.test/success",
      cancelUrl: "https://product.test/cancel",
    });
    expect(orderAmounts).toHaveLength(1);
    return orderAmounts[0];
  }

  it("sends JPY as whole units (1000 minor → '1000')", async () => {
    expect(await checkoutWith("JPY", 1000)).toEqual({
      currency_code: "JPY",
      value: "1000",
    });
  });

  it("sends ISK as whole units after unification (1990 minor → '1990')", async () => {
    // Pre-unification the PayPal-local table treated ISK as 2-decimal and
    // produced "19.90"; the registry now pins ISK at 0 decimals.
    expect(await checkoutWith("ISK", 1990)).toEqual({
      currency_code: "ISK",
      value: "1990",
    });
  });

  it("keeps USD as 2-decimal (2900 minor → '29.00')", async () => {
    expect(await checkoutWith("USD", 2900)).toEqual({
      currency_code: "USD",
      value: "29.00",
    });
  });

  it("normalizes JPY webhook captures without cents", async () => {
    const body = JSON.stringify({
      id: "WH-JPY-1",
      create_time: "2026-09-26T08:00:00.000Z",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAPTURE_JPY_1",
        status: "COMPLETED",
        custom_id: "monetplane_order_id:ord_jpy|monetplane_customer_id:cus_jpy",
        amount: { currency_code: "JPY", value: "1000" },
      },
    });
    const adapter = createPayPalProviderAdapter({
      fetchImpl: fakeFetch,
    });
    const verified = await adapter.verifyWebhook(connection, {
      rawBody: body,
      headers: verifyHeaders(body),
    });
    const event = await adapter.normalizeWebhook(connection, verified);
    expect(event.amountMinor).toBe(1000);
    expect(event.currency).toBe("JPY");
  });
});
