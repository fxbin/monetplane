import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../src/modules/providers/adapters/mock";
import type { ProviderConnectionContext } from "../src/modules/providers/contract";
import { defineProviderAdapterContractTests } from "./provider-contract/adapter-contract";

const connection: ProviderConnectionContext = {
  id: "pconn_mock_contract",
  applicationId: "app_contract",
  provider: "mock",
  mode: "test",
  metadata: {},
  credentials: { webhookSecret: "contract-secret" },
};

const rawBody = JSON.stringify({
  id: "evt_contract_1",
  type: "payment.succeeded",
  occurred_at: "2026-08-18T12:00:00.000Z",
  data: {
    provider_customer_id: "mock_customer_1",
    provider_payment_id: "mock_payment_1",
    monetplane_order_id: "ord_contract_1",
    monetplane_customer_id: "cus_contract_1",
    amount_minor: 999,
    currency: "USD",
  },
});

defineProviderAdapterContractTests({
  name: "mock",
  adapter: mockProviderAdapter,
  connection,
  checkout: {
    applicationId: connection.applicationId,
    monetplaneOrderId: "ord_contract_1",
    monetplaneCustomerId: "cus_contract_1",
    billingMode: "one_time",
    currency: "USD",
    items: [
      {
        productId: "prod_contract",
        priceId: "price_contract",
        quantity: 1,
        unitAmountMinor: 999,
      },
    ],
    successUrl: "https://product.test/success",
    cancelUrl: "https://product.test/cancel",
  },
  validWebhook: {
    rawBody,
    headers: {
      "x-monetplane-mock-signature": signMockWebhookPayload(
        rawBody,
        "contract-secret",
      ),
    },
  },
  invalidWebhook: {
    rawBody: "{not-valid-json",
    headers: { "x-monetplane-mock-signature": "00" },
  },
  expectedEventId: "evt_contract_1",
  expectedEventType: "payment.succeeded",
});
