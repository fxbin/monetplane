import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptWebhookSecret,
  generateWebhookSecret,
  signWebhookPayload,
} from "../src/modules/webhooks/crypto";
import {
  normalizeWebhookEventTypes,
  normalizeWebhookUrl,
} from "../src/modules/webhooks/service";
import {
  assertSafeWebhookDestination,
  isPrivateOrReservedIp,
} from "../src/modules/webhooks/ssrf";

const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
const originalAllowLocalWebhooks = process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS;

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  delete process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS;
});

afterEach(() => {
  if (originalAllowLocalWebhooks === undefined) {
    delete process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS;
  } else {
    process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS = originalAllowLocalWebhooks;
  }
});

describe("developer webhook contract", () => {
  it("reveals a generated signing secret while persisting only ciphertext metadata", () => {
    const generated = generateWebhookSecret();
    expect(generated.secret).toMatch(/^mp_whsec_/);
    expect(generated.secretPrefix).toMatch(/^mp_whsec_/);
    expect(generated.secretCiphertext).not.toContain(generated.secret);
    expect(decryptWebhookSecret(generated.secretCiphertext)).toBe(
      generated.secret,
    );
  });

  it("produces a deterministic versioned HMAC signature", () => {
    const signature = signWebhookPayload(
      "mp_whsec_test",
      "evt_123",
      "1789518000",
      '{"type":"system.test"}',
    );
    expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(
      signWebhookPayload(
        "mp_whsec_test",
        "evt_123",
        "1789518000",
        '{"type":"system.test"}',
      ),
    ).toBe(signature);
    expect(
      signWebhookPayload(
        "mp_whsec_test",
        "evt_124",
        "1789518000",
        '{"type":"system.test"}',
      ),
    ).not.toBe(signature);
  });

  it("requires https for production endpoints and gates localhost behind test opt-in", () => {
    expect(normalizeWebhookUrl("https://api.example.com/hook", "live")).toBe(
      "https://api.example.com/hook",
    );
    expect(() =>
      normalizeWebhookUrl("http://localhost:3001/hook", "live"),
    ).toThrow("must use https");
    // Fail-closed by default even in test mode unless explicitly opted in.
    expect(() =>
      normalizeWebhookUrl("http://localhost:3001/hook", "test"),
    ).toThrow("private, loopback, or internal");

    process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS = "true";
    expect(normalizeWebhookUrl("http://localhost:3001/hook", "test")).toBe(
      "http://localhost:3001/hook",
    );
    // Live mode never allows localhost even with local opt-in enabled.
    expect(() =>
      normalizeWebhookUrl("https://localhost:3001/hook", "live"),
    ).toThrow("private, loopback, or internal");
  });

  it("blocks private, metadata, internal, and IPv4-mapped IPv6 SSRF targets", async () => {
    process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS = "true";
    expect(() =>
      normalizeWebhookUrl("http://169.254.169.254/latest/meta-data", "test"),
    ).toThrow("private, loopback, or internal");
    expect(() =>
      normalizeWebhookUrl("http://169.254.169.254/latest/meta-data", "live"),
    ).toThrow("must use https");

    for (const blocked of [
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/hook",
      "https://172.16.0.1/hook",
      "https://192.168.1.1/hook",
      "https://100.64.0.1/hook",
      "https://[fe80::1]/hook",
      "https://[fc00::1]/hook",
      "https://[::ffff:169.254.169.254]/hook",
      "https://[::ffff:7f00:1]/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://service.local/hook",
    ]) {
      expect(() => normalizeWebhookUrl(blocked, "test")).toThrow(
        "private, loopback, or internal",
      );
      expect(() => normalizeWebhookUrl(blocked, "live")).toThrow(
        "private, loopback, or internal",
      );
    }

    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:7f00:1")).toBe(true);

    // DNS rebinding defense: public domain resolving to metadata or loopback is rejected.
    await expect(
      assertSafeWebhookDestination("https://hooks.attacker.test/cb", "live", {
        lookupImpl: async () => [{ address: "169.254.169.254", family: 4 }],
      }),
    ).rejects.toThrow("private, loopback, or internal");

    await expect(
      assertSafeWebhookDestination("http://hooks.attacker.test/cb", "test", {
        lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toThrow("private, loopback, or internal");

    await expect(
      assertSafeWebhookDestination("https://hooks.example.com/cb", "live", {
        lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).resolves.toBeUndefined();
  });

  it("normalizes event subscriptions and supports wildcard delivery", () => {
    expect(normalizeWebhookEventTypes()).toEqual(["*"]);
    expect(
      normalizeWebhookEventTypes([" Payment.Succeeded ", "payment.succeeded"]),
    ).toEqual(["payment.succeeded"]);
    expect(() => normalizeWebhookEventTypes(["payment succeeded"])).toThrow(
      "Invalid webhook event type",
    );
  });
});
