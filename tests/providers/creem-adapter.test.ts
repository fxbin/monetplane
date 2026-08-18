import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCreemProviderAdapter } from "../../src/modules/providers/adapters/creem";
import type { ProviderConnectionContext } from "../../src/modules/providers/contract";
import { UnsupportedProviderCapabilityError } from "../../src/modules/providers/contract";

const connection: ProviderConnectionContext = {
  id: "pc_creem",
  applicationId: "app_creem",
  provider: "creem",
  mode: "test",
  metadata: {
    catalog: {
      price_monthly: { productId: "prod_monthly" },
      price_once: "prod_once",
    },
  },
  credentials: {
    apiKey: "creem_test_key",
    webhookSecret: "creem_webhook_secret",
  },
};

function signedPayload(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    headers: {
      "creem-signature": createHmac("sha256", "creem_webhook_secret")
        .update(rawBody)
        .digest("hex"),
    },
  };
}

describe("Creem adapter", () => {
  it("maps MonetPlane checkout metadata and catalog mapping to Creem", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://creem.test/v1/checkouts");
      expect(init?.method).toBe("POST");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "ch_1",
          checkout_url: "https://checkout.creem.test/ch_1",
          customer: { id: "cust_1" },
        }),
        { status: 200 },
      );
    };
    const adapter = createCreemProviderAdapter({
      fetchImpl: fakeFetch,
      baseUrls: { test: "https://creem.test" },
    });

    const result = await adapter.createCheckout(connection, {
      applicationId: "app_creem",
      monetplaneOrderId: "ord_1",
      monetplaneCustomerId: "cus_1",
      billingMode: "subscription",
      interval: "month",
      currency: "USD",
      items: [
        {
          productId: "product_internal",
          priceId: "price_monthly",
          quantity: 3,
          unitAmountMinor: 1900,
        },
      ],
      successUrl: "https://product.test/success",
      cancelUrl: "https://product.test/cancel",
      providerCustomerId: "cust_existing",
      metadata: { campaign: "launch" },
    });

    expect(result.providerCheckoutId).toBe("ch_1");
    expect(result.providerCustomerId).toBe("cust_1");
    expect(requestBody).toMatchObject({
      product_id: "prod_monthly",
      request_id: "ord_1",
      units: 3,
      customer: { id: "cust_existing" },
      success_url: "https://product.test/success",
      metadata: {
        campaign: "launch",
        monetplane_application_id: "app_creem",
        monetplane_order_id: "ord_1",
        monetplane_customer_id: "cus_1",
        monetplane_price_id: "price_monthly",
        monetplane_cancel_url: "https://product.test/cancel",
      },
    });
  });

  it("fails fast instead of collapsing multi-product checkout", async () => {
    const adapter = createCreemProviderAdapter({
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await expect(
      adapter.createCheckout(connection, {
        applicationId: "app_creem",
        monetplaneOrderId: "ord_multi",
        monetplaneCustomerId: "cus_1",
        billingMode: "one_time",
        currency: "USD",
        items: [
          {
            productId: "p1",
            priceId: "price_once",
            quantity: 1,
            unitAmountMinor: 1000,
          },
          {
            productId: "p2",
            priceId: "price_monthly",
            quantity: 1,
            unitAmountMinor: 1900,
          },
        ],
        successUrl: "https://product.test/success",
        cancelUrl: "https://product.test/cancel",
      }),
    ).rejects.toThrow("exactly one mapped product");
  });

  it("normalizes transaction retrieval and immediate cancellation", async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        body: init?.body ? String(init.body) : undefined,
      });
      if (url.includes("/v1/transactions?")) {
        return new Response(
          JSON.stringify({
            id: "tran_1",
            status: "paid",
            amount: 1900,
            amount_paid: 2100,
            currency: "USD",
            customer: "cust_1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/subscriptions/sub_1/cancel")) {
        return new Response(
          JSON.stringify({
            id: "sub_1",
            status: "canceled",
            customer: { id: "cust_1" },
            current_period_start_date: "2026-08-01T00:00:00.000Z",
            current_period_end_date: "2026-09-01T00:00:00.000Z",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const adapter = createCreemProviderAdapter({
      fetchImpl: fakeFetch,
      baseUrls: { test: "https://creem.test" },
    });

    expect(await adapter.getPayment(connection, { providerPaymentId: "tran_1" })).toEqual({
      providerPaymentId: "tran_1",
      status: "succeeded",
      amountMinor: 2100,
      currency: "USD",
      providerCustomerId: "cust_1",
    });
    expect(
      await adapter.cancelSubscription(connection, {
        providerSubscriptionId: "sub_1",
      }),
    ).toMatchObject({
      providerSubscriptionId: "sub_1",
      status: "cancelled",
      providerCustomerId: "cust_1",
      cancelAtPeriodEnd: false,
    });
    expect(requests[0]?.url).toContain("transaction_id=tran_1");
    expect(requests[1]).toMatchObject({
      url: "https://creem.test/v1/subscriptions/sub_1/cancel",
      method: "POST",
      body: JSON.stringify({ mode: "immediate", onExecute: "cancel" }),
    });
  });

  it("does not advertise operations Creem does not expose in the public merchant API", async () => {
    const adapter = createCreemProviderAdapter();
    const capabilities = adapter.getCapabilities(connection);
    expect(capabilities.refund).toBe(false);
    expect(capabilities.subscription_update).toBe(false);
    await expect(
      adapter.refundPayment(connection, { providerPaymentId: "tran_1" }),
    ).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
    await expect(
      adapter.updateSubscription(connection, {
        providerSubscriptionId: "sub_1",
      }),
    ).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });

  it("uses subscription.paid as the paid-period event and keeps subscription.active sync-only", async () => {
    const adapter = createCreemProviderAdapter();
    const active = signedPayload({
      id: "evt_active",
      eventType: "subscription.active",
      created_at: 1787076000000,
      object: {
        id: "sub_1",
        status: "active",
        customer: { id: "cust_1" },
        metadata: {
          monetplane_order_id: "ord_1",
          monetplane_customer_id: "cus_1",
        },
      },
    });
    const paid = signedPayload({
      id: "evt_paid",
      eventType: "subscription.paid",
      created_at: 1787076060000,
      object: {
        id: "sub_1",
        status: "active",
        customer: { id: "cust_1" },
        last_transaction_id: "tran_paid_1",
        current_period_start_date: "2026-08-18T00:00:00.000Z",
        current_period_end_date: "2026-09-18T00:00:00.000Z",
        metadata: {
          monetplane_order_id: "ord_1",
          monetplane_customer_id: "cus_1",
        },
      },
    });

    const activeVerified = await adapter.verifyWebhook(connection, active);
    const paidVerified = await adapter.verifyWebhook(connection, paid);
    expect(await adapter.normalizeWebhook(connection, activeVerified)).toMatchObject({
      type: "subscription.created",
      providerSubscriptionId: "sub_1",
      subscriptionStatus: "pending",
    });
    expect(await adapter.normalizeWebhook(connection, paidVerified)).toMatchObject({
      type: "subscription.renewed",
      providerSubscriptionId: "sub_1",
      providerPaymentId: "tran_paid_1",
      subscriptionStatus: "active",
      subscriptionPeriodStart: "2026-08-18T00:00:00.000Z",
      subscriptionPeriodEnd: "2026-09-18T00:00:00.000Z",
    });
  });

  it("normalizes scheduled cancellation, past due, and merchant-created refund events", async () => {
    const adapter = createCreemProviderAdapter();
    const scheduled = signedPayload({
      id: "evt_scheduled",
      eventType: "subscription.scheduled_cancel",
      created_at: 1787076100000,
      object: {
        id: "sub_1",
        status: "scheduled_cancel",
        customer: { id: "cust_1" },
        current_period_start_date: "2026-08-18T00:00:00.000Z",
        current_period_end_date: "2026-09-18T00:00:00.000Z",
      },
    });
    const pastDue = signedPayload({
      id: "evt_due",
      eventType: "subscription.past_due",
      created_at: 1787076200000,
      object: {
        id: "sub_1",
        customer: { id: "cust_1" },
        product: { price: 1900, currency: "USD" },
      },
    });
    const refund = signedPayload({
      id: "evt_refund",
      eventType: "refund.created",
      created_at: 1787076300000,
      object: {
        id: "ref_1",
        refund_amount: 1210,
        refund_currency: "EUR",
        transaction: { id: "tran_1" },
        subscription: { id: "sub_1", status: "canceled" },
        customer: { id: "cust_1" },
      },
    });

    expect(
      await adapter.normalizeWebhook(
        connection,
        await adapter.verifyWebhook(connection, scheduled),
      ),
    ).toMatchObject({
      type: "subscription.updated",
      cancelAtPeriodEnd: true,
      subscriptionStatus: "active",
    });
    expect(
      await adapter.normalizeWebhook(
        connection,
        await adapter.verifyWebhook(connection, pastDue),
      ),
    ).toMatchObject({
      type: "payment.failed",
      providerSubscriptionId: "sub_1",
      providerPaymentId: "creem-event:evt_due",
      amountMinor: 1900,
      currency: "USD",
    });
    expect(
      await adapter.normalizeWebhook(
        connection,
        await adapter.verifyWebhook(connection, refund),
      ),
    ).toMatchObject({
      type: "payment.refunded",
      providerPaymentId: "tran_1",
      providerRefundId: "ref_1",
      providerSubscriptionId: "sub_1",
      amountMinor: 1210,
      currency: "EUR",
    });
  });
});
