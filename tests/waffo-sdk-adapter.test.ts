import { describe, expect, it } from "vitest";
import { createWaffoProviderAdapter } from "../src/modules/providers/adapters/waffo";
import type { ProviderConnectionContext } from "../src/modules/providers/contract";
import {
  ProviderOperationError,
  UnsupportedProviderCapabilityError,
} from "../src/modules/providers/contract";
import {
  adapterWith,
  pancakeFake,
} from "./provider-contract/waffo-adapter.test";

const connection: ProviderConnectionContext = {
  id: "pc_waffo_unit",
  applicationId: "app_unit",
  provider: "waffo",
  mode: "test",
  metadata: {},
  credentials: {
    merchantId: "MER_unittest",
    privateKey: "-----BEGIN PRIVATE KEY-----\nunit\n-----END PRIVATE KEY-----",
    storeId: "STO_unittest",
  },
};

function pancakeEvent(
  eventType: string,
  data: Record<string, unknown>,
  id = `wh_${eventType.replace(/\./g, "_")}`,
) {
  return JSON.stringify({
    id,
    timestamp: "2026-09-19T08:00:00.000Z",
    eventType,
    eventId: `EVT_${id}`,
    storeId: "STO_unittest",
    storeName: "Unit Store",
    mode: "test",
    data,
  });
}

describe("waffo pancake adapter", () => {
  it("creates an idempotent product shell and passes order correlation into the session", async () => {
    const fake = pancakeFake();
    const adapter = adapterWith(fake);
    const result = await adapter.createCheckout(connection, {
      applicationId: connection.applicationId,
      monetplaneOrderId: "ord_unit_1",
      monetplaneCustomerId: "cus_unit_1",
      customerEmail: "buyer@test",
      billingMode: "one_time",
      currency: "USD",
      items: [
        {
          productId: "prod_unit",
          productName: "Unit Pro Plan",
          priceId: "price_unit",
          quantity: 2,
          unitAmountMinor: 2495,
        },
      ],
      successUrl: "https://product.test/success",
      cancelUrl: "https://product.test/cancel",
    });

    const shell = fake.calls.find((c) => c.op === "onetimeProducts.create");
    expect(shell?.params).toMatchObject({
      storeId: "STO_unittest",
      name: "mp-unit-pro-plan",
      prices: { USD: { amount: "49.90", taxCategory: "saas" } },
    });
    const session = fake.calls.find((c) => c.op === "checkout.createSession");
    expect(session?.params).toMatchObject({
      productId: "PROD_onetime_shell",
      currency: "USD",
      buyerEmail: "buyer@test",
      orderMerchantExternalId: "ord_unit_1",
      metadata: {
        monetplaneOrderId: "ord_unit_1",
        monetplaneCustomerId: "cus_unit_1",
      },
    });
    expect(result.providerCheckoutId).toBe("CHK_contract_1");
  });

  it("maps subscription shells to weekly/monthly/yearly billing periods and gates trials", async () => {
    const fake = pancakeFake();
    const adapter = adapterWith(fake);
    for (const [interval, period] of [
      ["week", "weekly"],
      ["month", "monthly"],
      ["year", "yearly"],
    ] as const) {
      await adapter.createCheckout(connection, {
        applicationId: connection.applicationId,
        monetplaneOrderId: `ord_${period}`,
        monetplaneCustomerId: "cus_unit_1",
        billingMode: "subscription",
        interval,
        trialPeriodDays: period === "monthly" ? 14 : undefined,
        currency: "USD",
        items: [
          {
            productId: "prod_unit",
            productName: "Unit Plan",
            priceId: "price_unit",
            quantity: 1,
            unitAmountMinor: 900,
          },
        ],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      });
    }
    const subs = fake.calls.filter(
      (c) => c.op === "subscriptionProducts.create",
    );
    expect(subs.map((c) => c.params.billingPeriod)).toEqual([
      "weekly",
      "monthly",
      "yearly",
    ]);
    const sessions = fake.calls.filter(
      (c) => c.op === "checkout.createSession",
    );
    expect(sessions[1]?.params.withTrial).toBe(true);
    expect(sessions[0]?.params.withTrial).toBeUndefined();
  });

  it("rejects multi-item checkouts (Pancake sessions are single-product)", async () => {
    const adapter = adapterWith(pancakeFake());
    await expect(
      adapter.createCheckout(connection, {
        applicationId: connection.applicationId,
        monetplaneOrderId: "ord_multi",
        monetplaneCustomerId: "cus_unit_1",
        billingMode: "one_time",
        currency: "USD",
        items: [
          {
            productId: "a",
            priceId: "pa",
            quantity: 1,
            unitAmountMinor: 100,
          },
          {
            productId: "b",
            priceId: "pb",
            quantity: 1,
            unitAmountMinor: 200,
          },
        ],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      }),
    ).rejects.toThrow(UnsupportedProviderCapabilityError);
  });

  it("normalizes the documented Pancake event taxonomy", async () => {
    const adapter = adapterWith(pancakeFake());
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "order.completed",
        {
          orderId: "ORD_1",
          currency: "USD",
          amount: "29.00",
          paymentId: "PAY_1",
          orderMerchantExternalId: "ord_mp",
        },
        "payment.succeeded",
      ],
      [
        "subscription.payment_succeeded",
        {
          orderId: "SUB_1",
          currency: "USD",
          amount: "9.00",
          paymentId: "PAY_2",
        },
        "payment.succeeded",
      ],
      [
        "subscription.activated",
        {
          orderId: "SUB_1",
          orderStatus: "active",
          currency: "USD",
          amount: "9.00",
          currentPeriodStart: "2026-09-01",
          currentPeriodEnd: "2026-10-01",
        },
        "subscription.activated",
      ],
      [
        "subscription.renewed",
        {
          orderId: "SUB_1",
          orderStatus: "active",
          currency: "USD",
          amount: "9.00",
        },
        "subscription.renewed",
      ],
      [
        "subscription.canceling",
        {
          orderId: "SUB_1",
          orderStatus: "canceling",
          currency: "USD",
          amount: "9.00",
        },
        "subscription.updated",
      ],
      [
        "subscription.past_due",
        {
          orderId: "SUB_1",
          orderStatus: "past_due",
          currency: "USD",
          amount: "9.00",
        },
        "subscription.updated",
      ],
      [
        "subscription.canceled",
        {
          orderId: "SUB_1",
          orderStatus: "canceled",
          currency: "USD",
          amount: "9.00",
        },
        "subscription.cancelled",
      ],
      [
        "refund.succeeded",
        {
          orderId: "ORD_1",
          currency: "USD",
          amount: "29.00",
          paymentId: "PAY_1",
        },
        "payment.refunded",
      ],
      [
        "refund.failed",
        {
          orderId: "ORD_1",
          currency: "USD",
          amount: "29.00",
          paymentId: "PAY_1",
        },
        "unknown",
      ],
    ];
    for (const [eventType, data, expectedType] of cases) {
      const event = await adapter.normalizeWebhook(connection, {
        rawBody: pancakeEvent(eventType, data),
      });
      expect(event.type, eventType).toBe(expectedType);
      expect(event.providerEventId).toMatch(/^wh_/);
    }
  });

  it("correlates webhooks via orderMerchantExternalId and metadata, converting display amounts", async () => {
    const adapter = adapterWith(pancakeFake());
    const event = await adapter.normalizeWebhook(connection, {
      rawBody: pancakeEvent("order.completed", {
        orderId: "ORD_corr",
        currency: "USD",
        amount: "49.90",
        paymentId: "PAY_corr",
        orderMerchantExternalId: "ord_corr",
        orderMetadata: { monetplaneCustomerId: "cus_corr" },
      }),
    });
    expect(event.monetplaneOrderId).toBe("ord_corr");
    expect(event.monetplaneCustomerId).toBe("cus_corr");
    expect(event.amountMinor).toBe(4990);
  });

  it("verifies x-waffo-signature with the environment pinned from the connection", async () => {
    const seen: Array<string | null | undefined> = [];
    const adapter = createWaffoProviderAdapter({
      clientFactory: () => pancakeFake().client as never,
      verifyWebhookImpl: (payload, signatureHeader, opts) => {
        seen.push(signatureHeader);
        seen.push(String(opts?.environment));
        return JSON.parse(payload) as never;
      },
    });
    await adapter.verifyWebhook(connection, {
      rawBody: pancakeEvent("order.completed", { amount: "1.00" }),
      headers: { "X-Waffo-Signature": "t=1,v1=x" },
    });
    expect(seen[0]).toBe("t=1,v1=x");
    expect(seen[1]).toBe("test");

    // live connections verify against prod keys — fail closed per env.
    await adapter.verifyWebhook(
      { ...connection, mode: "live" },
      {
        rawBody: pancakeEvent("order.completed", { amount: "1.00" }),
        headers: { "x-waffo-signature": "t=1,v1=x" },
      },
    );
    expect(seen[3]).toBe("prod");
  });

  it("cancels subscriptions by Pancake order id and classifies SDK failures", async () => {
    const fake = pancakeFake();
    const adapter = adapterWith(fake);
    const cancelled = await adapter.cancelSubscription(connection, {
      providerSubscriptionId: "SUB_cancel",
    });
    expect(cancelled).toMatchObject({
      providerSubscriptionId: "SUB_cancel",
      status: "cancelled",
    });

    const failing = createWaffoProviderAdapter({
      clientFactory: () =>
        ({
          ...fake.client,
          orders: {
            cancelSubscription: async () => {
              const err = new Error("gateway exploded") as Error & {
                status: number;
                errors: unknown[];
              };
              err.status = 503;
              err.name = "WaffoPancakeError";
              throw err;
            },
          },
        }) as never,
      verifyWebhookImpl: (payload) => JSON.parse(payload) as never,
    });
    await expect(
      failing.cancelSubscription(connection, {
        providerSubscriptionId: "SUB_x",
      }),
    ).rejects.toThrow(ProviderOperationError);
  });

  it("submits refund tickets via customer sessions and maps ticket status", async () => {
    const fake = pancakeFake();
    const adapter = adapterWith(fake);
    const refund = await adapter.refundPayment(connection, {
      providerPaymentId: "PAY_refund",
      amountMinor: 2990,
      requestId: "req_refund_1",
    });
    expect(refund).toMatchObject({
      providerRefundId: "TCK_refund_1",
      providerPaymentId: "PAY_refund",
      status: "pending",
      amountMinor: 2990,
    });
    const ticket = fake.calls.find(
      (c) => c.op === "customer.createRefundTicket",
    );
    expect(ticket?.params).toMatchObject({
      paymentId: "PAY_refund",
      refundTicketMerchantExternalId: "req_refund_1",
    });
    expect(ticket?.params.requestedAmount).toMatchObject({
      amount: "29.90",
      currency: "USD",
    });
  });
});
