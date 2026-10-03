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

const ROUTES: Record<string, { route: string; verb: string }> = {
  upsertCustomer: { route: "src/app/api/customers/route.ts", verb: "POST" },
  createCheckout: { route: "src/app/api/checkout/route.ts", verb: "POST" },
  createCustomerPortalSession: {
    route: "src/app/api/portal/sessions/route.ts",
    verb: "POST",
  },
  createCustomerReadToken: {
    route: "src/app/api/customer-read-tokens/route.ts",
    verb: "POST",
  },
  revokeCustomerReadToken: {
    route: "src/app/api/customer-read-tokens/[tokenId]/route.ts",
    verb: "DELETE",
  },
  debitCredits: { route: "src/app/api/credits/debit/route.ts", verb: "POST" },
  getCreditBalance: {
    route: "src/app/api/credits/balance/route.ts",
    verb: "POST",
  },
  reserveCredits: {
    route: "src/app/api/credits/reserve/route.ts",
    verb: "POST",
  },
  captureReservation: {
    route: "src/app/api/credits/capture/route.ts",
    verb: "POST",
  },
  releaseReservation: {
    route: "src/app/api/credits/release/route.ts",
    verb: "POST",
  },
  checkEntitlement: {
    route: "src/app/api/entitlements/check/route.ts",
    verb: "POST",
  },
  reportUsage: { route: "src/app/api/usage/report/route.ts", verb: "POST" },
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
      "createCustomerReadToken",
      "debitCredits",
      "getCreditBalance",
      "releaseReservation",
      "reportUsage",
      "reserveCredits",
      "revokeCustomerReadToken",
      "upsertCustomer",
    ]);
  });

  it("every SDK method has a matching server route (drift guard)", () => {
    for (const [method, { route, verb }] of Object.entries(ROUTES)) {
      const path = join(process.cwd(), route);
      expect(existsSync(path), `${method} -> ${route} missing`).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(source, `${route} must export ${verb}`).toContain(
        `export async function ${verb}`,
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
