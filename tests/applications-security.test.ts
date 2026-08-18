import { describe, expect, it } from "vitest";
import {
  generateApplicationCredential,
  hashApplicationCredential,
  normalizeCallbackOrigin,
  normalizeHostname,
} from "../src/modules/applications/security";

describe("application security helpers", () => {
  it("normalizes branded hosts and strips ports", () => {
    expect(normalizeHostname("Billing.AhaFrame.com:443")).toBe(
      "billing.ahaframe.com",
    );
  });

  it("rejects malformed host input", () => {
    expect(() => normalizeHostname("evil.com@billing.ahaframe.com")).toThrow();
    expect(() => normalizeHostname("billing.ahaframe.com/path")).toThrow();
  });

  it("normalizes callbacks to an allow-listable origin", () => {
    expect(
      normalizeCallbackOrigin(
        "https://ahaframe.com/billing/success?order=example",
      ),
    ).toBe("https://ahaframe.com");
  });

  it("issues opaque secrets while keeping deterministic hashes", () => {
    const credential = generateApplicationCredential();

    expect(credential.secret).toMatch(/^mp_app_/);
    expect(credential.secretHash).not.toContain(credential.secret);
    expect(hashApplicationCredential(credential.secret)).toBe(
      credential.secretHash,
    );
  });
});
