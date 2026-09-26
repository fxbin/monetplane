import { createWaffoProviderAdapter } from "../../src/modules/providers/adapters/waffo";
import type { ProviderConnectionContext } from "../../src/modules/providers/contract";
import { defineProviderAdapterContractTests } from "./adapter-contract";

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

/** In-memory fake of the pancake-ts surface the adapter consumes. */
export function pancakeFake() {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const client = {
    onetimeProducts: {
      create: async (params: Record<string, unknown>) => {
        calls.push({ op: "onetimeProducts.create", params });
        return { product: { id: "PROD_onetime_shell" } };
      },
    },
    subscriptionProducts: {
      create: async (params: Record<string, unknown>) => {
        calls.push({ op: "subscriptionProducts.create", params });
        return { product: { id: "PROD_subscription_shell" } };
      },
    },
    checkout: {
      createSession: async (params: Record<string, unknown>) => {
        calls.push({ op: "checkout.createSession", params });
        return {
          sessionId: "CHK_contract_1",
          checkoutUrl: "https://checkout.waffo.ai/CHK_contract_1",
          expiresAt: "2026-09-20T00:00:00.000Z",
        };
      },
    },
    orders: {
      cancelSubscription: async (params: Record<string, unknown>) => {
        calls.push({ op: "orders.cancelSubscription", params });
        return { orderId: String(params.orderId), status: "canceled" };
      },
    },
    auth: {
      issueSessionToken: async (params: Record<string, unknown>) => {
        calls.push({ op: "auth.issueSessionToken", params });
        return { token: "session_token" };
      },
    },
    customer: (_token: string, _options?: Record<string, unknown>) => ({
      createRefundTicket: async (params: Record<string, unknown>) => {
        calls.push({ op: "customer.createRefundTicket", params });
        return {
          ticket: {
            id: "TCK_refund_1",
            status: "pending",
            subjectId: String(params.paymentId),
          },
        };
      },
    }),
  };
  return { client, calls };
}

export function adapterWith(fake: ReturnType<typeof pancakeFake>) {
  return createWaffoProviderAdapter({
    clientFactory: () => fake.client as never,
    verifyWebhookImpl: (payload) => JSON.parse(payload) as never,
  });
}

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
