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
