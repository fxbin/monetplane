import type { JsonRecord } from "../../src/modules/providers/adapters/shared";
import { createWaffoProviderAdapter } from "../../src/modules/providers/adapters/waffo";

/**
 * In-memory fake of the pancake-ts surface the adapter consumes, shared by
 * the waffo contract suite (waffo-adapter.test.ts) and the SDK-surface unit
 * tests (waffo-sdk-adapter.test.ts). Lives in a non-`*.test.ts` file so the
 * shared exports don't trip lint/suspicious/noExportsInTest.
 */
export function pancakeFake() {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const client = {
    onetimeProducts: {
      create: async (params: JsonRecord) => {
        calls.push({ op: "onetimeProducts.create", params });
        return { product: { id: "PROD_onetime_shell" } };
      },
    },
    subscriptionProducts: {
      create: async (params: JsonRecord) => {
        calls.push({ op: "subscriptionProducts.create", params });
        return { product: { id: "PROD_subscription_shell" } };
      },
    },
    checkout: {
      createSession: async (params: JsonRecord) => {
        calls.push({ op: "checkout.createSession", params });
        return {
          sessionId: "CHK_contract_1",
          checkoutUrl: "https://checkout.waffo.ai/CHK_contract_1",
          expiresAt: "2026-09-20T00:00:00.000Z",
        };
      },
    },
    orders: {
      cancelSubscription: async (params: JsonRecord) => {
        calls.push({ op: "orders.cancelSubscription", params });
        return { orderId: String(params.orderId), status: "canceled" };
      },
    },
    auth: {
      issueSessionToken: async (params: JsonRecord) => {
        calls.push({ op: "auth.issueSessionToken", params });
        return { token: "session_token" };
      },
    },
    customer: (_token: string, _options?: JsonRecord) => ({
      createRefundTicket: async (params: JsonRecord) => {
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
