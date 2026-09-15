import { describe, expect, it } from "vitest";
import { createWaffoProviderAdapter } from "../src/modules/providers/adapters/waffo";
import {
  classifyProviderOperationFailure,
  type ProviderConnectionContext,
  ProviderOperationError,
} from "../src/modules/providers/contract";

function success(data: Record<string, unknown>) {
  return {
    isSuccess: () => true,
    getData: () => data,
    getCode: () => "0",
    getMessage: () => "Success",
  };
}

function rejected(message: string) {
  return {
    isSuccess: () => false,
    getData: () => ({}),
    getCode: () => "WAFFO_REJECTED",
    getMessage: () => message,
  };
}

const connection: ProviderConnectionContext = {
  id: "pconn_waffo_sdk",
  applicationId: "app_waffo_sdk",
  provider: "waffo",
  mode: "test",
  metadata: {},
  credentials: {
    apiKey: "api_key",
    merchantId: "merchant_123",
    privateKey: "private_key",
    waffoPublicKey: "public_key",
    notifyUrl: "https://merchant.example.com/waffo/webhook",
  },
};

describe("Waffo official SDK adapter contract", () => {
  it("sends the required full-refund and cancellation fields", async () => {
    let refundParams: Record<string, unknown> | null = null;
    let cancelParams: Record<string, unknown> | null = null;

    const adapter = createWaffoProviderAdapter({
      clientFactory: () => ({
        order: () => ({
          refund: async (params) => {
            refundParams = params;
            return success({
              refundRequestId: params.refundRequestId,
              acquiringOrderId: params.acquiringOrderId,
              acquiringRefundOrderId: "refund_waffo_1",
              refundAmount: params.refundAmount,
              refundStatus: "ORDER_FULLY_REFUNDED",
            });
          },
        }),
        subscription: () => ({
          cancel: async (params) => {
            cancelParams = params;
            return success({
              subscriptionId: params.subscriptionId,
              orderStatus: "ORDER_SUCCESS",
            });
          },
        }),
        merchantConfig: () => ({
          inquiry: async () => success({ merchantId: "merchant_123" }),
        }),
        webhook: () => ({ verifySignature: () => true }),
      }),
    });

    const refund = await adapter.refundPayment(connection, {
      providerPaymentId: "order_123",
      amountMinor: 2599,
      requestId: "bop_attempt_2",
    });
    const cancellation = await adapter.cancelSubscription(connection, {
      providerSubscriptionId: "sub_123",
    });

    expect(refund.status).toBe("succeeded");
    expect(refund.providerRefundId).toBe("refund_waffo_1");
    expect(refundParams).toMatchObject({
      acquiringOrderId: "order_123",
      merchantId: "merchant_123",
      refundAmount: "25.99",
      refundReason: "MonetPlane operator full refund",
    });
    expect(refundParams?.refundRequestId).toMatch(/^refund_/);
    expect(refundParams?.requestedAt).toEqual(expect.any(String));

    expect(cancellation).toMatchObject({
      providerSubscriptionId: "sub_123",
      status: "cancelled",
      cancelAtPeriodEnd: false,
    });
    expect(cancelParams).toMatchObject({
      subscriptionId: "sub_123",
      merchantId: "merchant_123",
    });
    expect(cancelParams?.requestedAt).toEqual(expect.any(String));
  });

  it("runs a read-only merchant configuration diagnostic", async () => {
    let merchantParams: Record<string, unknown> | null = null;
    const adapter = createWaffoProviderAdapter({
      clientFactory: () => ({
        order: () => ({}),
        subscription: () => ({}),
        merchantConfig: () => ({
          inquiry: async (params) => {
            merchantParams = params;
            return success({ merchantId: "merchant_123" });
          },
        }),
        webhook: () => ({ verifySignature: () => true }),
      }),
    });

    const result = await adapter.validateConnection?.(connection);
    expect(merchantParams).toEqual({ merchantId: "merchant_123" });
    expect(result?.summary).toContain("RSA request/response verification");
  });

  it("classifies explicit provider rejection as retryable but transport ambiguity as uncertain", async () => {
    const rejectedAdapter = createWaffoProviderAdapter({
      clientFactory: () => ({
        order: () => ({
          refund: async () => rejected("Refund reason rejected"),
        }),
        subscription: () => ({}),
        merchantConfig: () => ({}),
        webhook: () => ({ verifySignature: () => true }),
      }),
    });

    const rejection = await rejectedAdapter
      .refundPayment(connection, {
        providerPaymentId: "order_rejected",
        amountMinor: 1000,
        requestId: "attempt_rejected",
      })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ProviderOperationError);
    expect(classifyProviderOperationFailure(rejection)).toBe("rejected");

    const uncertainAdapter = createWaffoProviderAdapter({
      clientFactory: () => ({
        order: () => ({
          refund: async () => {
            throw new Error("socket reset after request write");
          },
        }),
        subscription: () => ({}),
        merchantConfig: () => ({}),
        webhook: () => ({ verifySignature: () => true }),
      }),
    });
    const uncertainty = await uncertainAdapter
      .refundPayment(connection, {
        providerPaymentId: "order_uncertain",
        amountMinor: 1000,
        requestId: "attempt_uncertain",
      })
      .catch((error: unknown) => error);
    expect(classifyProviderOperationFailure(uncertainty)).toBe(
      "outcome_uncertain",
    );
  });

  it("does not claim subscription update until MonetPlane has the full Waffo change contract", () => {
    const adapter = createWaffoProviderAdapter({
      clientFactory: () => ({
        order: () => ({}),
        subscription: () => ({}),
        merchantConfig: () => ({}),
        webhook: () => ({ verifySignature: () => true }),
      }),
    });
    expect(adapter.getCapabilities(connection).subscription_update).toBe(false);
  });
});
