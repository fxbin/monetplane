import { describe, expect, it } from "vitest";
import type {
  CreateCheckoutInput,
  PaymentProviderAdapter,
  ProviderConnectionContext,
  VerifyWebhookInput,
} from "../../src/modules/providers/contract";
import { InvalidProviderWebhookSignatureError } from "../../src/modules/providers/contract";

export function defineProviderAdapterContractTests(input: {
  name: string;
  adapter: PaymentProviderAdapter;
  connection: ProviderConnectionContext;
  checkout: CreateCheckoutInput;
  validWebhook: VerifyWebhookInput;
  invalidWebhook: VerifyWebhookInput;
  expectedEventId: string;
  expectedEventType: string;
}) {
  describe(`${input.name} provider contract`, () => {
    it("declares explicit boolean capabilities", () => {
      const capabilities = input.adapter.getCapabilities(input.connection);
      expect(Object.keys(capabilities).sort()).toEqual(
        [
          "annual_interval",
          "customer_portal",
          "monthly_interval",
          "one_time_checkout",
          "provider_hosted_checkout",
          "recurring_subscription",
          "refund",
          "subscription_cancel",
          "subscription_update",
        ].sort(),
      );
      expect(
        Object.values(capabilities).every(
          (value) => typeof value === "boolean",
        ),
      ).toBe(true);
    });

    it("creates a normalized checkout with MonetPlane correlation metadata", async () => {
      const result = await input.adapter.createCheckout(
        input.connection,
        input.checkout,
      );

      expect(result.providerCheckoutId).toBeTruthy();
      expect(result.checkoutUrl).toMatch(/^https?:\/\//);
      expect(result.reconciliationMetadata.monetplane_order_id).toBe(
        input.checkout.monetplaneOrderId,
      );
      expect(result.reconciliationMetadata.monetplane_customer_id).toBe(
        input.checkout.monetplaneCustomerId,
      );
      expect(result).not.toHaveProperty("raw");
      expect(result).not.toHaveProperty("data");
    });

    it("rejects invalid signatures before normalization", async () => {
      await expect(
        input.adapter.verifyWebhook(input.connection, input.invalidWebhook),
      ).rejects.toBeInstanceOf(InvalidProviderWebhookSignatureError);
    });

    it("verifies and normalizes a stable provider event identity", async () => {
      const firstVerified = await input.adapter.verifyWebhook(
        input.connection,
        input.validWebhook,
      );
      const secondVerified = await input.adapter.verifyWebhook(
        input.connection,
        input.validWebhook,
      );

      const first = await input.adapter.normalizeWebhook(
        input.connection,
        firstVerified,
      );
      const second = await input.adapter.normalizeWebhook(
        input.connection,
        secondVerified,
      );

      expect(first.providerEventId).toBe(input.expectedEventId);
      expect(first.type).toBe(input.expectedEventType);
      expect(second.providerEventId).toBe(first.providerEventId);
      expect(first.providerConnectionId).toBe(input.connection.id);
      expect(first.applicationId).toBe(input.connection.applicationId);
      expect(first).not.toHaveProperty("rawBody");
      expect(first).not.toHaveProperty("raw");
      expect(first).not.toHaveProperty("data");
    });
  });
}
