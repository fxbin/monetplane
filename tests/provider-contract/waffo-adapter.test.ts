import { createWaffoProviderAdapter } from "../../src/modules/providers/adapters/waffo";
import type { ProviderConnectionContext } from "../../src/modules/providers/contract";
import { defineProviderAdapterContractTests } from "./adapter-contract";

function response(data: Record<string, unknown>) {
  return {
    isSuccess: () => true,
    getData: () => data,
    getCode: () => "0",
    getMessage: () => "Success",
  };
}

const connection: ProviderConnectionContext = {
  id: "pc_waffo_contract",
  applicationId: "app_contract",
  provider: "waffo",
  mode: "test",
  metadata: {},
  credentials: {
    apiKey: "waffo_test_key",
    merchantId: "merchant_contract",
    privateKey: "merchant_private_key",
    waffoPublicKey: "waffo_public_key",
    notifyUrl: "https://merchant.test/waffo/webhook",
  },
};

const adapter = createWaffoProviderAdapter({
  clientFactory: () => ({
    order: () => ({
      create: async () =>
        response({
          paymentRequestId: "req_waffo_provider_1",
          acquiringOrderId: "ord_waffo_provider_1",
          orderStatus: "PAY_IN_PROGRESS",
          orderAction: "https://checkout.waffo.test/ord_waffo_provider_1",
        }),
    }),
    subscription: () => ({}),
    merchantConfig: () => ({
      inquiry: async () => response({ merchantId: "merchant_contract" }),
    }),
    webhook: () => ({
      verifySignature: (_body: string, signature: string) =>
        signature === "valid-rsa-signature",
    }),
  }),
});

const webhookPayload = JSON.stringify({
  eventType: "PAYMENT_NOTIFICATION",
  eventId: "evt_waffo_contract",
  eventTime: "2026-08-24T12:00:00.000Z",
  result: {
    paymentRequestId: "req_waffo_provider_1",
    merchantOrderId: "ord_contract",
    acquiringOrderId: "pay_waffo_contract_1",
    orderStatus: "PAY_SUCCESS",
    orderAmount: "25.00",
    orderCurrency: "USD",
    userInfo: { userId: "cus_contract", userEmail: "dev@example.com" },
  },
});

defineProviderAdapterContractTests({
  name: "Waffo",
  adapter,
  connection,
  checkout: {
    applicationId: "app_contract",
    monetplaneOrderId: "ord_contract",
    monetplaneCustomerId: "cus_contract",
    customerEmail: "dev@example.com",
    billingMode: "one_time",
    currency: "USD",
    items: [
      {
        productId: "prod_internal",
        productName: "Starter",
        priceId: "price_internal",
        quantity: 1,
        unitAmountMinor: 2500,
      },
    ],
    successUrl: "https://product.test/success",
    cancelUrl: "https://product.test/cancel",
  },
  validWebhook: {
    rawBody: webhookPayload,
    headers: { "x-signature": "valid-rsa-signature" },
  },
  invalidWebhook: {
    rawBody: webhookPayload,
    headers: { "x-signature": "invalid-rsa-signature" },
  },
  expectedEventId: "evt_waffo_contract",
  expectedEventType: "payment.succeeded",
});
