import { afterEach, describe, expect, it } from "vitest";
import {
  getAuthRateLimitPerMinute,
  getPublicBaseUrl,
  isLocalWebhookDeliveryAllowed,
} from "../src/config/env";
import {
  isDatabaseQueryError,
  isUniqueConstraintError,
  safeAdminErrorMessage,
} from "../src/lib/db-errors";
import {
  consumeBoundedRateLimit,
  extractRateLimitClientBucket,
  type RateLimitWindow,
} from "../src/lib/rate-limit";
import { sanitizeLoginCallbackUrl } from "../src/lib/safe-redirect";

describe("sanitizeLoginCallbackUrl", () => {
  it("allows safe relative in-app paths with query and hash", () => {
    expect(sanitizeLoginCallbackUrl("/overview")).toBe("/overview");
    expect(sanitizeLoginCallbackUrl("/payments?status=succeeded#row1")).toBe(
      "/payments?status=succeeded#row1",
    );
  });

  it("rejects protocol-relative, backslash, absolute, and control-char open redirects", () => {
    for (const unsafe of [
      "//evil.com",
      "//evil.com/overview",
      "/\\evil.com",
      "https://evil.com/phish",
      "http://evil.com",
      "javascript:alert(1)",
      "/overview\r\nSet-Cookie: a=b",
      "",
      null,
      undefined,
    ]) {
      expect(sanitizeLoginCallbackUrl(unsafe)).toBe("/overview");
    }
  });
});

describe("bounded sliding-window rate limiter", () => {
  it("enforces limits, resets expired windows, and fails closed at maxWindows", () => {
    const windows = new Map<string, RateLimitWindow>();
    expect(
      consumeBoundedRateLimit(windows, "login:ip1", 2, {
        now: 1000,
        windowMs: 60_000,
        maxWindows: 2,
      }),
    ).toBe(true);
    expect(
      consumeBoundedRateLimit(windows, "login:ip1", 2, {
        now: 1001,
        windowMs: 60_000,
        maxWindows: 2,
      }),
    ).toBe(true);
    expect(
      consumeBoundedRateLimit(windows, "login:ip1", 2, {
        now: 1002,
        windowMs: 60_000,
        maxWindows: 2,
      }),
    ).toBe(false);

    // Fill second slot
    expect(
      consumeBoundedRateLimit(windows, "login:ip2", 2, {
        now: 1003,
        windowMs: 60_000,
        maxWindows: 2,
      }),
    ).toBe(true);
    // Map saturated -> fails closed for new keys
    expect(
      consumeBoundedRateLimit(windows, "login:ip3", 2, {
        now: 1004,
        windowMs: 60_000,
        maxWindows: 2,
      }),
    ).toBe(false);

    // After expiry, stale windows are pruned and new keys succeed
    expect(
      consumeBoundedRateLimit(windows, "login:ip3", 2, {
        now: 70_000,
        windowMs: 60_000,
        maxWindows: 2,
      }),
    ).toBe(true);
  });

  it("ignores x-forwarded-for unless trustProxy is enabled", () => {
    const req = new Request("https://console.example/login", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    expect(extractRateLimitClientBucket(req, false)).toBe("shared");
    expect(extractRateLimitClientBucket(req, true)).toBe("203.0.113.9");
  });
});

describe("security hardening env getters", () => {
  const keys = [
    "MONETPLANE_AUTH_RATE_LIMIT",
    "MONETPLANE_ALLOW_LOCAL_WEBHOOKS",
    "MONETPLANE_PUBLIC_URL",
  ] as const;
  const originals = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    for (const key of keys) {
      const val = originals.get(key);
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("parses auth rate limit and local webhook flag fail-closed", () => {
    delete process.env.MONETPLANE_AUTH_RATE_LIMIT;
    delete process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS;
    expect(getAuthRateLimitPerMinute()).toBe(20);
    expect(isLocalWebhookDeliveryAllowed()).toBe(false);

    process.env.MONETPLANE_AUTH_RATE_LIMIT = "5";
    process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS = "true";
    expect(getAuthRateLimitPerMinute()).toBe(5);
    expect(isLocalWebhookDeliveryAllowed()).toBe(true);

    process.env.MONETPLANE_AUTH_RATE_LIMIT = "-1";
    expect(getAuthRateLimitPerMinute()).toBe(20);
  });

  it("validates MONETPLANE_PUBLIC_URL fail-closed and strips trailing path", () => {
    delete process.env.MONETPLANE_PUBLIC_URL;
    expect(getPublicBaseUrl()).toBeUndefined();

    process.env.MONETPLANE_PUBLIC_URL = "https://billing.example.com/extra";
    expect(getPublicBaseUrl()).toBe("https://billing.example.com");

    process.env.MONETPLANE_PUBLIC_URL = "ftp://billing.example.com";
    expect(() => getPublicBaseUrl()).toThrow("http or https");

    process.env.MONETPLANE_PUBLIC_URL = "not-a-url";
    expect(() => getPublicBaseUrl()).toThrow("valid URL");
  });
});

describe("DrizzleQueryError unwrapping and SQL leak prevention", () => {
  it("detects unique constraint errors across Drizzle cause chains and redacts query SQL", () => {
    const pgCause = Object.assign(
      new Error('duplicate key value violates unique constraint "slug_unique"'),
      { code: "23505", name: "PostgresError" },
    );
    const drizzleErr = Object.assign(
      new Error('Failed query: insert into "applications" ... params: secret'),
      { name: "DrizzleQueryError", cause: pgCause },
    );

    expect(isUniqueConstraintError(drizzleErr)).toBe(true);
    expect(isDatabaseQueryError(drizzleErr)).toBe(true);
    expect(safeAdminErrorMessage(drizzleErr, "Failed to create project")).toBe(
      "Failed to create project",
    );

    const validationErr = new Error("Application name is required");
    expect(isUniqueConstraintError(validationErr)).toBe(false);
    expect(isDatabaseQueryError(validationErr)).toBe(false);
    expect(
      safeAdminErrorMessage(validationErr, "Failed to create project"),
    ).toBe("Application name is required");
  });
});
