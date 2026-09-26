import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMonetPlaneClient } from "../../src/sdk/server";

/**
 * SDK packaging contract (#65).
 *
 * These tests fail when the packaged SDK drifts from the server's real
 * routes or when the package build stops producing a distributable
 * artifact shape.
 */

const ROUTES: Record<string, string> = {
  upsertCustomer: "src/app/api/customers/route.ts",
  createCheckout: "src/app/api/checkout/route.ts",
  debitCredits: "src/app/api/credits/debit/route.ts",
  getCreditBalance: "src/app/api/credits/balance/route.ts",
  reserveCredits: "src/app/api/credits/reserve/route.ts",
  captureReservation: "src/app/api/credits/capture/route.ts",
  releaseReservation: "src/app/api/credits/release/route.ts",
  checkEntitlement: "src/app/api/entitlements/check/route.ts",
  reportUsage: "src/app/api/usage/report/route.ts",
};

describe("SDK packaging contract", () => {
  it("exports exactly the provider-neutral client methods", () => {
    const client = createMonetPlaneClient({
      baseUrl: "https://api.test",
      appSecret: "mp_app_test",
    });
    expect(Object.keys(client).sort()).toEqual([
      "captureReservation",
      "checkEntitlement",
      "createCheckout",
      "createCustomerPortalSession",
      "debitCredits",
      "getCreditBalance",
      "releaseReservation",
      "reportUsage",
      "reserveCredits",
      "upsertCustomer",
    ]);
  });

  it("every SDK method has a matching server route (drift guard)", () => {
    for (const [method, route] of Object.entries(ROUTES)) {
      const path = join(process.cwd(), route);
      expect(existsSync(path), `${method} -> ${route} missing`).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(source, `${route} must export POST`).toContain(
        "export async function POST",
      );
    }
  });

  it("packages/sdk declares a distributable export map for @monetplane/sdk/server", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "packages/sdk/package.json"), "utf8"),
    ) as {
      name: string;
      exports: Record<string, { types: string; default: string }>;
    };
    expect(pkg.name).toBe("@monetplane/sdk");
    expect(pkg.exports["./server"].default).toBe("./dist/server.js");
    expect(pkg.exports["."].default).toBe("./dist/index.js");
  });

  it("server SDK entry never imports server-only runtime dependencies", () => {
    const source = readFileSync(
      join(process.cwd(), "src/sdk/server.ts"),
      "utf8",
    );
    // The SDK must stay dependency-free and browser-safe to bundle on
    // servers: no next/*, no node: built-ins, no provider SDKs.
    expect(source).not.toMatch(/from "next\//);
    expect(source).not.toMatch(/from "node:/);
    expect(source).not.toMatch(/from "@waffo\//);
    expect(source).not.toMatch(/from "creem/);
  });
});
