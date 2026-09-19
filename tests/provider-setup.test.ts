import { describe, expect, it } from "vitest";
import {
  getProviderSetup,
  validateProviderSetupCredentials,
} from "../src/modules/providers/setup";

describe("provider setup metadata", () => {
  it("defines the supported console providers", () => {
    expect(getProviderSetup("creem")?.label).toBe("Creem");
    expect(getProviderSetup("waffo")?.label).toBe("Waffo Pancake");
    expect(getProviderSetup("stripe")).toBeNull();
  });

  it("requires the Waffo Pancake credential contract (merchantId/privateKey/storeId)", () => {
    expect(() =>
      validateProviderSetupCredentials("waffo", {
        merchantId: "MER_valid123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        storeId: "STO_valid123",
      }),
    ).not.toThrow();

    expect(() =>
      validateProviderSetupCredentials("waffo", {
        merchantId: "wrong-shape",
        privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        storeId: "STO_valid123",
      }),
    ).toThrow(/Merchant ID must look like MER_/);

    expect(() =>
      validateProviderSetupCredentials("waffo", {
        merchantId: "MER_valid123",
        privateKey: "definitely not a key !!!",
        storeId: "STO_valid123",
      }),
    ).toThrow(/private key must be a PEM string or its base64 encoding/i);

    expect(() =>
      validateProviderSetupCredentials("waffo", {
        merchantId: "MER_valid123",
        privateKey: "SGVsbG8=",
      }),
    ).toThrow(/Store ID is required/);
  });

  it("accepts base64-encoded private keys", () => {
    expect(() =>
      validateProviderSetupCredentials("waffo", {
        merchantId: "MER_valid123",
        privateKey: Buffer.from(
          "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        ).toString("base64"),
        storeId: "STO_valid123",
      }),
    ).not.toThrow();
  });
});
