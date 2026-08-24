import { createHmac } from "node:crypto";
import { createWaffoProviderAdapter } from "../../src/modules/providers/adapters/waffo";
import type { ProviderConnectionContext } from "../../src/modules/providers/contract";
import { defineProviderAdapterContractTests } from "./adapter-contract";

const signingSecret = "waffo-contract-signing-secret";
const webhookSecret = "waffo-contract-webhook-secret";

const connection: ProviderConnectionContext = {
  id: "pc_waffo_contract",
  applicationId: "app_contract",
  provider: "waffo",
  mode: "test",
  metadata: {
    catalog: {
      price_internal: { productId: "prod_waffo_contract" },
    },
  },
  credentials: {
    apiKey: "waffo_test_key",
    signingSecret,
    webhookSecret,
  },
};

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (
    url === "https://waffo.test/api/v1/order/create" &&
    init?.method === "POST"
  ) {
    return new Response(
      JSON.stringify({
        code: "0",
        msg: "Success",
        data: {
          orderId: "ord_waffo_provider_1",
          checkoutUrl: "https://checkout.waffo.test/ord_waffo_provider_1",
          customerId: "cust_waffo_1",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({ code: "404", msg: `Unexpected request: ${url}` }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
};

const adapter = createWaffoProviderAdapter({
  fetchImpl: fakeFetch,
  baseUrls: { test: "https://waffo.test" },
});

const webhookPayload = JSON.stringify({
  eventType: "PAYMENT_NOTIFICATION",
  eventId: "evt_waffo_contract",
  eventTime: "2026-08-24T12:00:00.000Z",
  result: {
    acquiringOrderId: "pay_waffo_contract_1",
    orderStatus: "PAY_SUCCESS",
    orderAmount: "25.00",
    orderCurrency: "USD",
    customerId: "cust_waffo_1",
    orderMerchantExternalId: "ord_contract",
    customerMerchantExternalId: "cus_contract",
  },
});

function signWebhook(payload: string) {
  return {
    "x-signature": createHmac("sha256", webhookSecret)
      .update(payload)
      .digest("hex"),
  };
}

defineProviderAdapterContractTests({
  name: "Waffo",
  adapter,
  connection,
  checkout: {
    applicationId: "app_contract",
    monetplaneOrderId: "ord_contract",
    monetplaneCustomerId: "cus_contract",
    billingMode: "one_time",
    currency: "USD",
    items: [
      {
        productId: "prod_internal",
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
    headers: signWebhook(webhookPayload),
  },
  invalidWebhook: {
    rawBody: webhookPayload,
    headers: { "x-signature": "00".repeat(32) },
  },
  expectedEventId: "evt_waffo_contract",
  expectedEventType: "payment.succeeded",
});
