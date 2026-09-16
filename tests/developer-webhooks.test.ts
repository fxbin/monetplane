import { beforeEach, describe, expect, it } from "vitest";
import {
  decryptWebhookSecret,
  generateWebhookSecret,
  signWebhookPayload,
} from "../src/modules/webhooks/crypto";
import {
  normalizeWebhookEventTypes,
  normalizeWebhookUrl,
} from "../src/modules/webhooks/service";

const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
});

describe("developer webhook contract", () => {
  it("reveals a generated signing secret while persisting only ciphertext metadata", () => {
    const generated = generateWebhookSecret();
    expect(generated.secret).toMatch(/^mp_whsec_/);
    expect(generated.secretPrefix).toMatch(/^mp_whsec_/);
    expect(generated.secretCiphertext).not.toContain(generated.secret);
    expect(decryptWebhookSecret(generated.secretCiphertext)).toBe(generated.secret);
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

  it("requires https for production endpoints", () => {
    expect(normalizeWebhookUrl("https://api.example.com/hook", "live")).toBe(
      "https://api.example.com/hook",
    );
    expect(() => normalizeWebhookUrl("http://localhost:3001/hook", "live")).toThrow(
      "must use https",
    );
    expect(normalizeWebhookUrl("http://localhost:3001/hook", "test")).toBe(
      "http://localhost:3001/hook",
    );
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
