import { afterEach, describe, expect, it } from "vitest";
import { getDatabaseUrl } from "../src/config/env";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("getDatabaseUrl", () => {
  it("accepts PostgreSQL URLs", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/monetplane";
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
