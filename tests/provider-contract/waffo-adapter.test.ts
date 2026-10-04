import { describe, expect, it } from "vitest";
import type { ProviderConnectionContext } from "../../src/modules/providers/contract";
import { defineProviderAdapterContractTests } from "./adapter-contract";
import { adapterWith, pancakeFake } from "./waffo-pancake-fake";

const connection: ProviderConnectionContext = {
  id: "pc_waffo_contract",
  applicationId: "app_contract",
  provider: "waffo",
  mode: "test",
  metadata: {},
  credentials: {
    merchantId: "MER_contracttest",
    privateKey:
      "-----BEGIN PRIVATE KEY-----\ncontract\n-----END PRIVATE KEY-----",
    storeId: "STO_contracttest",
  },
};

const fake = pancakeFake();
const adapter = adapterWith(fake);

const unknownEventBody = JSON.stringify({
  id: "wh_delivery_unknown_1",
  timestamp: "2026-09-19T00:00:00.000Z",
  eventType: "definitely.not.a.real.event",
  eventId: "PAY_unknown_1",
  storeId: "STO_contracttest",
  storeName: "Contract Store",
  mode: "test",
  data: {
    orderId: "ORD_unknown_1",
    orderStatus: "completed",
    buyerEmail: "buyer@test",
    currency: "USD",
    amount: "29.00",
    taxAmount: "0.00",
    total: "29.00",
    productName: "Contract Pro",
  },
});

const orderCompletedBody = JSON.stringify({
  id: "wh_delivery_contract_1",
  timestamp: "2026-09-19T00:00:00.000Z",
  eventType: "order.completed",
  eventId: "PAY_contract_1",
  storeId: "STO_contracttest",
  storeName: "Contract Store",
  mode: "test",
  data: {
    orderId: "ORD_contract_1",
    orderStatus: "completed",
    buyerEmail: "buyer@test",
    currency: "USD",
    amount: "29.00",
    taxAmount: "0.00",
    total: "29.00",
    productName: "Contract Pro",
    paymentId: "PAY_contract_1",
    paymentStatus: "succeeded",
    orderMerchantExternalId: "ord_contract_waffo",
  },
});

defineProviderAdapterContractTests({
  name: "waffo (Pancake)",
  adapter,
  connection,
  checkout: {
    applicationId: connection.applicationId,
    monetplaneOrderId: "ord_contract_waffo",
    monetplaneCustomerId: "cus_contract_waffo",
    billingMode: "one_time",
    currency: "USD",
    items: [
      {
        productId: "prod_contract",
        productName: "Contract Pro",
        priceId: "price_contract",
        quantity: 1,
        unitAmountMinor: 2900,
      },
    ],
    successUrl: "https://product.test/success",
    cancelUrl: "https://product.test/cancel",
  },
  validWebhook: {
    rawBody: orderCompletedBody,
    headers: { "x-waffo-signature": "t=1,v1=contract" },
  },
  invalidWebhook: {
    rawBody: orderCompletedBody,
    headers: {},
  },
  unknownWebhook: {
    rawBody: unknownEventBody,
    headers: { "x-waffo-signature": "t=1,v1=contract" },
  },
  expectedEventId: "wh_delivery_contract_1",
  expectedEventType: "payment.succeeded",
  expectedUnknownEventName: "definitely.not.a.real.event",
});

// Fail-closed subscription status mapping (project review 2026-10-04,
// finding 1.1): a missing or unrecognized Pancake orderStatus must never
// infer "active", because webhook entitlement grants key off status ===
// "active". Known values follow the SDK SubscriptionOrderStatus machine.
describe("waffo subscription status normalization (fail-closed)", () => {
  const subscriptionEventBody = (overrides: {
    eventType: string;
    orderStatus?: string;
  }) => {
    const data: Record<string, unknown> = {
      orderId: "ORD_sub_status",
      buyerEmail: "buyer@test",
      currency: "USD",
      amount: "29.00",
      currentPeriodStart: "2026-09-01T00:00:00.000Z",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    };
    if (overrides.orderStatus !== undefined) {
      data.orderStatus = overrides.orderStatus;
    }
    return JSON.stringify({
      id: `wh_delivery_${overrides.eventType}_${overrides.orderStatus ?? "absent"}`,
      timestamp: "2026-09-19T00:00:00.000Z",
      eventType: overrides.eventType,
      eventId: "PAY_sub_status",
      storeId: "STO_contracttest",
      storeName: "Contract Store",
      mode: "test",
      data,
    });
  };

  const normalize = async (body: string) =>
    adapter.normalizeWebhook(connection, { rawBody: body });

  it("infers pending when orderStatus is absent on a past_due event", async () => {
    const event = await normalize(
      subscriptionEventBody({ eventType: "subscription.past_due" }),
    );
    expect(event.type).toBe("subscription.updated");
    expect(event.subscriptionStatus).toBe("pending");
  });

  it("infers pending for an unrecognized orderStatus value", async () => {
    const event = await normalize(
      subscriptionEventBody({
        eventType: "subscription.activated",
        orderStatus: "brand_new_future_status",
      }),
    );
    expect(event.subscriptionStatus).toBe("pending");
  });

  it("maps past_due orderStatus to past_due", async () => {
    const event = await normalize(
      subscriptionEventBody({
        eventType: "subscription.past_due",
        orderStatus: "past_due",
      }),
    );
    expect(event.subscriptionStatus).toBe("past_due");
  });

  it("keeps service active for canceling with cancelAtPeriodEnd", async () => {
    const event = await normalize(
      subscriptionEventBody({
        eventType: "subscription.canceling",
        orderStatus: "canceling",
      }),
    );
    expect(event.type).toBe("subscription.updated");
    expect(event.subscriptionStatus).toBe("active");
    expect(event.cancelAtPeriodEnd).toBe(true);
  });

  it("maps closed (never-activated terminal) to cancelled", async () => {
    const event = await normalize(
      subscriptionEventBody({
        eventType: "subscription.plan_change_failed",
        orderStatus: "closed",
      }),
    );
    expect(event.subscriptionStatus).toBe("cancelled");
  });
});
