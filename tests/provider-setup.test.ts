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

  it("requires Waffo signing and webhook secrets", () => {
    expect(() =>
      validateProviderSetupCredentials("waffo", {
        apiKey: "waffo_key",
        webhookSecret: "webhook_secret",
      }),
    ).toThrow("Signing secret is required for Waffo");
  });

  it("rejects unsupported provider names", () => {
    expect(() => validateProviderSetupCredentials("stripe", {})).toThrow(
      "supported payment provider",
    );
  });
});
