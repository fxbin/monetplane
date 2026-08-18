import { describe, expect, it } from "vitest";
import {
  decryptProviderCredentials,
  encryptProviderCredentials,
} from "../src/modules/providers/crypto";

const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

describe("provider credential encryption", () => {
  it("round-trips credentials without embedding plaintext", () => {
    const encrypted = encryptProviderCredentials(
      { apiKey: "secret-api-key", webhookSecret: "secret-webhook" },
      key,
    );

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain("secret-api-key");
    expect(encrypted).not.toContain("secret-webhook");
    expect(decryptProviderCredentials(encrypted, key)).toEqual({
      apiKey: "secret-api-key",
      webhookSecret: "secret-webhook",
    });
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptProviderCredentials({ apiKey: "secret" }, key);
    const parts = encrypted.split(":");
    parts[2] = `${parts[2]}A`;

    expect(() => decryptProviderCredentials(parts.join(":"), key)).toThrow();
  });
});
