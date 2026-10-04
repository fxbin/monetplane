import { afterEach, describe, expect, it } from "vitest";
import { getAuthSecret, getDatabaseUrl } from "../src/config/env";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthSecret = process.env.AUTH_SECRET;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalAuthSecret === undefined) {
    delete process.env.AUTH_SECRET;
  } else {
    process.env.AUTH_SECRET = originalAuthSecret;
  }
});

describe("getDatabaseUrl", () => {
  it("accepts PostgreSQL URLs", () => {
    process.env.DATABASE_URL =
      "postgresql://user:pass@localhost:5432/monetplane";
    expect(getDatabaseUrl()).toBe(process.env.DATABASE_URL);
  });

  it("rejects missing URLs", () => {
    delete process.env.DATABASE_URL;
    expect(() => getDatabaseUrl()).toThrow("DATABASE_URL is required");
  });

  it("rejects non-PostgreSQL URLs", () => {
    process.env.DATABASE_URL = "mysql://localhost/monetplane";
    expect(() => getDatabaseUrl()).toThrow(
      "DATABASE_URL must be a PostgreSQL connection string",
    );
  });
});

describe("getAuthSecret", () => {
  it("returns the trimmed secret", () => {
    process.env.AUTH_SECRET = "  secret-value  ";
    expect(getAuthSecret()).toBe("secret-value");
  });

  it("rejects missing secrets", () => {
    delete process.env.AUTH_SECRET;
    expect(() => getAuthSecret()).toThrow("AUTH_SECRET is required");
  });

  it("rejects whitespace-only secrets", () => {
    process.env.AUTH_SECRET = "   ";
    expect(() => getAuthSecret()).toThrow("AUTH_SECRET is required");
  });
});

describe("centralized env getters (roundtable batch 3)", () => {
  const keys = [
    "CRON_SECRET",
    "ADMIN_PASSWORD",
    "MONETPLANE_ENCRYPTION_KEY",
    "MONETPLANE_HOST_READ_LIMIT",
    "MONETPLANE_HOST_READ_MAX_WINDOWS",
    "MONETPLANE_TRUST_PROXY",
  ] as const;
  const originals = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    for (const key of keys) {
      const original = originals.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("trims secret getters and treats unset as undefined (fail closed)", async () => {
    const { getCronSecret, getAdminPassword, getEncryptionKeyMaterial } =
      await import("../src/config/env");
    delete process.env.CRON_SECRET;
    expect(getCronSecret()).toBeUndefined();
    process.env.CRON_SECRET = "  spaced-secret  ";
    expect(getCronSecret()).toBe("spaced-secret");
    expect(getAdminPassword()).toBeUndefined();
    expect(getEncryptionKeyMaterial()).toBeUndefined();
  });

  it("applies safe defaults to host-read tunables", async () => {
    const {
      getHostReadLimitPerMinute,
      getHostReadMaxWindows,
      isTrustProxyEnabled,
    } = await import("../src/config/env");
    delete process.env.MONETPLANE_HOST_READ_LIMIT;
    delete process.env.MONETPLANE_HOST_READ_MAX_WINDOWS;
    expect(getHostReadLimitPerMinute()).toBe(60);
    expect(getHostReadMaxWindows()).toBe(10_000);
    process.env.MONETPLANE_HOST_READ_LIMIT = "3";
    process.env.MONETPLANE_HOST_READ_MAX_WINDOWS = "500";
    expect(getHostReadLimitPerMinute()).toBe(3);
    expect(getHostReadMaxWindows()).toBe(500);
    process.env.MONETPLANE_HOST_READ_LIMIT = "not-a-number";
    expect(getHostReadLimitPerMinute()).toBe(60);
    expect(isTrustProxyEnabled()).toBe(false);
    process.env.MONETPLANE_TRUST_PROXY = "true";
    expect(isTrustProxyEnabled()).toBe(true);
  });
});
