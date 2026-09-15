import { describe, expect, it } from "vitest";
import {
  getProviderSetup,
  validateProviderSetupCredentials,
} from "../src/modules/providers/setup";

describe("provider setup metadata", () => {
  it("defines the supported console providers", () => {
    expect(getProviderSetup("creem")?.label).toBe("Creem");
    expect(getProviderSetup("waffo")?.label).toBe("Waffo");
    expect(getProviderSetup("mock")).toBeNull();
  });

  it("normalizes Creem credentials and ignores unknown fields", () => {
    expect(
      validateProviderSetupCredentials("creem", {
        apiKey: "  creem_key  ",
        webhookSecret: " webhook_secret ",
        ignored: "do-not-store",
      }),
    ).toEqual({
      apiKey: "creem_key",
      webhookSecret: "webhook_secret",
    });
  });

  it("requires the current Waffo RSA credential contract", () => {
    expect(() =>
      validateProviderSetupCredentials("waffo", {
        apiKey: "waffo_key",
        merchantId: "merchant_1",
        privateKey: "private_key",
        notifyUrl: "https://billing.example.com/waffo",
      }),
    ).toThrow("Waffo public key is required for Waffo");

    expect(
      validateProviderSetupCredentials("waffo", {
        apiKey: " waffo_key ",
        merchantId: " merchant_1 ",
        privateKey: " private_key ",
        waffoPublicKey: " public_key ",
        notifyUrl: " https://billing.example.com/waffo ",
        signingSecret: "legacy-value-must-not-be-stored",
      }),
    ).toEqual({
      apiKey: "waffo_key",
      merchantId: "merchant_1",
      privateKey: "private_key",
      waffoPublicKey: "public_key",
      notifyUrl: "https://billing.example.com/waffo",
    });
  });

  it("requires an HTTPS Waffo notification URL", () => {
    expect(() =>
      validateProviderSetupCredentials("waffo", {
        apiKey: "waffo_key",
        merchantId: "merchant_1",
        privateKey: "private_key",
        waffoPublicKey: "public_key",
        notifyUrl: "http://localhost:3000/webhook",
      }),
    ).toThrow("must use HTTPS");
  });

  it("rejects unsupported provider names", () => {
    expect(() => validateProviderSetupCredentials("stripe", {})).toThrow(
      "supported payment provider",
    );
  });
});
