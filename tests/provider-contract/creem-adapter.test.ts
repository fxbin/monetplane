import { createHmac } from "node:crypto";
import { createCreemProviderAdapter } from "../../src/modules/providers/adapters/creem";
import { createProviderContractSuite } from "./adapter-contract";

const webhookSecret = "creem-contract-secret";

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://creem.test/v1/checkouts" && init?.method === "POST") {
    return new Response(
      JSON.stringify({
        id: "ch_contract_1",
        checkout_url: "https://checkout.creem.test/ch_contract_1",
        customer: "cust_contract_1",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ message: `Unexpected request: ${url}` }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
};

const adapter = createCreemProviderAdapter({
  fetchImpl: fakeFetch,
  baseUrls: { test: "https://creem.test" },
});

createProviderContractSuite({
  name: "Creem",
  adapter,
  context: {
    id: "pc_creem_contract",
    applicationId: "app_contract",
    provider: "creem",
    mode: "test",
    metadata: {
      catalog: {
        price_internal: { productId: "prod_contract" },
      },
    },
    credentials: {
      apiKey: "creem_test_key",
      webhookSecret,
    },
  },
  checkoutInput: {
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
  webhookPayload: JSON.stringify({
    id: "evt_contract",
    eventType: "checkout.completed",
    created_at: 1787076000000,
    object: {
      id: "ch_contract_1",
      request_id: "ord_contract",
      metadata: {
        monetplane_order_id: "ord_contract",
        monetplane_customer_id: "cus_contract",
      },
      customer: { id: "cust_contract_1" },
      order: {
        transaction: "tran_contract_1",
        amount_paid: 2500,
        currency: "USD",
        type: "onetime",
      },
    },
  }),
  signWebhook(payload) {
    return {
      "creem-signature": createHmac("sha256", webhookSecret)
        .update(payload)
        .digest("hex"),
    };
  },
  invalidWebhookHeaders: { "creem-signature": "00".repeat(32) },
  expectedNormalizedEvent: {
    type: "payment.succeeded",
    providerEventId: "evt_contract",
  },
});
