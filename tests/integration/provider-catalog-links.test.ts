import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewPOST } from "../../src/app/api/admin/providers/catalog-links/preview/route";
import { POST as linkPOST } from "../../src/app/api/admin/providers/catalog-links/route";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { prices as pricesTable } from "../../src/modules/catalog/schema";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import { operatorAuditLog } from "../../src/modules/operations/audit-schema";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import type {
  NormalizedProviderCatalogProduct,
  PaymentProviderAdapter,
} from "../../src/modules/providers/contract";
import { ProviderOperationError } from "../../src/modules/providers/contract";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import { createProviderCheckout } from "../../src/modules/providers/runtime";
import {
  providerCatalogMappings,
  providerConnections,
} from "../../src/modules/providers/schema";
import {
  createProviderConnection,
  revokeProviderConnection,
} from "../../src/modules/providers/service";
import {
  acceptInvitation,
  findMembershipByEmail,
  inviteMember,
} from "../../src/modules/team/service";
import { CONSOLE_APPLICATION_COOKIE } from "../../src/server/control-plane/context";

/**
 * Route-level integration for the provider catalog link flow (#155):
 * real admin guard + console context + database, with a stub "creem"
 * adapter registered over the real one so provider lookups and checkout
 * item enrichment are observable without network access. Mirrors the
 * auth-mocking pattern of operator-audit.test.ts; the console cookie mock
 * pins the selected application so test isolation does not depend on
 * application ordering.
 */
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: vi.fn(),
  draftMode: vi.fn(),
}));

const { auth } = await import("@/auth");
const mockAuth = vi.mocked(auth);
const { cookies } = await import("next/headers");
const mockCookies = vi.mocked(cookies);

const db = getDb();

const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

let stubProduct: NormalizedProviderCatalogProduct | null;
let stubLookupError: Error | null;
let capturedCheckoutItems: Array<{
  priceId: string;
  providerProductId?: string;
}>;
let selectedApplicationId: string | null;

const stubCreemAdapter: PaymentProviderAdapter = {
  ...mockProviderAdapter,
  provider: "creem",
  async getCatalogProduct(_connection, input) {
    if (stubLookupError) throw stubLookupError;
    if (
      !stubProduct ||
      stubProduct.providerProductId !== input.providerProductId
    ) {
      throw new ProviderOperationError(
        `Creem product not found: ${input.providerProductId}`,
        "rejected",
      );
    }
    return stubProduct;
  },
  async createCheckout(_connection, input) {
    // Append (never reassign) so assertions can read every call's items.
    capturedCheckoutItems.push(
      ...input.items.map((item) => ({
        priceId: item.priceId,
        providerProductId: item.providerProductId,
      })),
    );
    return {
      providerCheckoutId: "ch_stub",
      checkoutUrl: "https://stub.test/ch_stub",
      reconciliationMetadata: {},
    };
  },
};

function defaultStubProduct(
  overrides: Record<string, unknown> = {},
): NormalizedProviderCatalogProduct {
  return {
    providerProductId: "prod_ok",
    name: "Pro",
    status: "active",
    mode: "test",
    billingType: "one_time",
    amountMinor: 1900,
    currency: "USD",
    recurringInterval: null,
    intervalCount: null,
    taxCategory: "saas",
    ...overrides,
  } as NormalizedProviderCatalogProduct;
}

async function seedOperator(role: "owner" | "viewer") {
  const email = `clink-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { token } = await inviteMember({
    email,
    role,
    applicationScope: "all",
    applicationIds: [],
    invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
  });
  await acceptInvitation({
    token,
    name: "Catalog Linker",
    password: "must(sup3rsecret)",
  });
  const membership = await findMembershipByEmail(email);
  if (!membership) throw new Error("membership missing after accept");
  mockAuth.mockResolvedValue({
    user: { id: membership.operatorId, credentialVersion: 0 },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as never);
  return membership;
}

async function seedCatalog(suffix: string) {
  const app = await createApplication(
    { slug: `clink-${suffix}`, name: `CLink ${suffix}` },
    db,
  );
  const connection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "creem",
      name: `creem-${suffix}`,
      mode: "test",
      credentials: { apiKey: "test-key", webhookSecret: "test-secret" },
      metadata: {},
    },
    db,
  );
  const product = await createProduct(
    { applicationId: app.id, key: `pro-${suffix}`, name: `Pro ${suffix}` },
    db,
  );
  const price = await createPrice(
    {
      applicationId: app.id,
      productId: product.id,
      key: "default",
      currency: "USD",
      amountMinor: 1900,
      billingType: "one_time",
    },
    db,
  );
  selectedApplicationId = app.id;
  return { app, connection, product, price };
}

function catalogLinksRequest(body: unknown, path = "") {
  return new Request(
    `https://console.test/api/admin/providers/catalog-links${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

async function linkProduct(seed: Awaited<ReturnType<typeof seedCatalog>>) {
  return linkPOST(
    catalogLinksRequest({
      connectionId: seed.connection.id,
      priceId: seed.price.id,
      providerProductId: stubProduct?.providerProductId ?? "prod_ok",
    }),
  );
}

async function mappingsFor(applicationId: string) {
  return db
    .select()
    .from(providerCatalogMappings)
    .where(eq(providerCatalogMappings.applicationId, applicationId));
}

async function auditFor(applicationId: string) {
  return db
    .select()
    .from(operatorAuditLog)
    .where(eq(operatorAuditLog.applicationId, applicationId));
}

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  stubProduct = defaultStubProduct();
  stubLookupError = null;
  capturedCheckoutItems = [];
  selectedApplicationId = null;
  clearProviderAdaptersForTests();
  registerProviderAdapter(stubCreemAdapter);
  mockAuth.mockReset();
  mockCookies.mockImplementation(
    async () =>
      ({
        get: (name: string) =>
          name === CONSOLE_APPLICATION_COOKIE && selectedApplicationId
            ? { value: selectedApplicationId }
            : undefined,
      }) as never,
  );
});

afterAll(async () => {
  // No explicit table cleanup: the shared integration setup truncates the
  // application-owned graph before every test, and deleting applications
  // directly would cascade into operator_audit_log whose append-only
  // trigger rejects the delete.
  await getSqlClient().end({ timeout: 1 });
});

describe("provider catalog link flow (#155)", () => {
  it("previews read-only: verifies the match without persisting anything", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("preview");

    const response = await previewPOST(
      catalogLinksRequest(
        {
          connectionId: seed.connection.id,
          priceId: seed.price.id,
          providerProductId: "prod_ok",
        },
        "/preview",
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      preview: { match: { ok: boolean }; providerProductId: string };
    };
    expect(body.preview.match.ok).toBe(true);
    expect(body.preview.providerProductId).toBe("prod_ok");
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);
    expect(await auditFor(seed.app.id)).toHaveLength(0);
  });

  it("links a matching provider product and audits the creation", async () => {
    const membership = await seedOperator("owner");
    const seed = await seedCatalog("link");

    const response = await linkProduct(seed);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      outcome: string;
      mapping: { providerProductId: string; source: string; status: string };
    };
    expect(body.outcome).toBe("linked");
    expect(body.mapping).toMatchObject({
      providerProductId: "prod_ok",
      source: "linked",
      status: "synced",
    });

    const mappings = await mappingsFor(seed.app.id);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      applicationId: seed.app.id,
      providerConnectionId: seed.connection.id,
      environment: "test",
      monetplanePriceId: seed.price.id,
      providerProductId: "prod_ok",
    });

    const entries = await auditFor(seed.app.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "provider_catalog.linked",
      resourceType: "provider_catalog_mapping",
      actorId: membership.operatorId,
      environment: "test",
    });
  });

  it("is idempotent for the identical link and only refreshes verification", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("idem");

    const first = await linkProduct(seed);
    expect(first.status).toBe(201);

    const second = await linkProduct(seed);

    expect(second.status).toBe(200);
    const body = (await second.json()) as { outcome: string };
    expect(body.outcome).toBe("already_linked");
    expect(await mappingsFor(seed.app.id)).toHaveLength(1);

    const entries = await auditFor(seed.app.id);
    expect(entries.map((entry) => entry.action)).toEqual([
      "provider_catalog.link_reverified",
      "provider_catalog.linked",
    ]);
  });

  it("refuses to silently rebind a price to a different provider product", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("conflict");

    const first = await linkProduct(seed);
    expect(first.status).toBe(201);
    stubProduct = defaultStubProduct({ providerProductId: "prod_other" });

    const response = await linkProduct(seed);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("mapping_conflict");
    const mappings = await mappingsFor(seed.app.id);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.providerProductId).toBe("prod_ok");

    // The rejected rebind is audited alongside the original link.
    const entries = await auditFor(seed.app.id);
    expect(entries.map((entry) => entry.action)).toEqual([
      "provider_catalog.link_rejected",
      "provider_catalog.linked",
    ]);
  });

  it("rejects mismatched currency without persisting and audits the rejection", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("mismatch");
    stubProduct = defaultStubProduct({ currency: "EUR" });

    const response = await linkProduct(seed);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      details: { mismatches: Array<{ field: string }> };
    };
    expect(body.code).toBe("product_mismatch");
    expect(body.details.mismatches.map((m) => m.field)).toContain("currency");
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);

    const entries = await auditFor(seed.app.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "provider_catalog.link_rejected",
    });
  });

  it("rejects archived and mode-mismatched provider products", async () => {
    await seedOperator("owner");

    const archivedSeed = await seedCatalog("archived");
    stubProduct = defaultStubProduct({ status: "archived" });
    const archived = await linkProduct(archivedSeed);
    expect(archived.status).toBe(400);

    const modeSeed = await seedCatalog("mode");
    stubProduct = defaultStubProduct({ mode: "live" });
    const wrongMode = await linkProduct(modeSeed);
    expect(wrongMode.status).toBe(400);
    const modeBody = (await wrongMode.json()) as {
      details: { mismatches: Array<{ field: string }> };
    };
    expect(modeBody.details.mismatches.map((m) => m.field)).toContain("mode");

    expect(await mappingsFor(archivedSeed.app.id)).toHaveLength(0);
    expect(await mappingsFor(modeSeed.app.id)).toHaveLength(0);
  });

  it("fails closed when the provider product does not exist", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("notfound");

    const response = await linkPOST(
      catalogLinksRequest({
        connectionId: seed.connection.id,
        priceId: seed.price.id,
        providerProductId: "prod_missing",
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("provider_lookup_failed");
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);
  });

  it("classifies providers without catalog lookup as unsupported, not lookup-failed", async () => {
    // F1 regression: an adapter without getCatalogProduct must surface
    // provider_unsupported, not a generic provider_lookup_failed.
    await seedOperator("owner");
    const seed = await seedCatalog("unsupported");
    const lookuplessAdapter: PaymentProviderAdapter = {
      ...mockProviderAdapter,
      provider: "creem",
    };
    registerProviderAdapter(lookuplessAdapter);

    const response = await previewPOST(
      catalogLinksRequest(
        {
          connectionId: seed.connection.id,
          priceId: seed.price.id,
          providerProductId: "prod_ok",
        },
        "/preview",
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("provider_unsupported");
    expect(body.error).toContain("does not support");
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);
  });

  it("rejects a legacy metadata mapping that points at a different product", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("legacy");

    await db
      .update(providerConnections)
      .set({
        metadata: { catalog: { [seed.price.id]: "prod_old" } },
      })
      .where(eq(providerConnections.id, seed.connection.id));

    const conflict = await linkPOST(
      catalogLinksRequest({
        connectionId: seed.connection.id,
        priceId: seed.price.id,
        providerProductId: "prod_ok",
      }),
    );
    expect(conflict.status).toBe(400);
    expect(((await conflict.json()) as { code: string }).code).toBe(
      "legacy_mapping_conflict",
    );
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);

    // Legacy metadata pointing at the SAME product stays linkable.
    stubProduct = defaultStubProduct({ providerProductId: "prod_old" });
    const same = await linkPOST(
      catalogLinksRequest({
        connectionId: seed.connection.id,
        priceId: seed.price.id,
        providerProductId: "prod_old",
      }),
    );
    expect(same.status).toBe(201);
    expect(await mappingsFor(seed.app.id)).toHaveLength(1);
  });

  it("rejects cross-application connections and wrong-environment connections", async () => {
    await seedOperator("owner");

    // Cross-application: connection belongs to another app than the
    // selected application's price.
    const seedA = await seedCatalog("app-a");
    const seedB = await seedCatalog("app-b");
    selectedApplicationId = seedA.app.id;

    const crossApp = await linkPOST(
      catalogLinksRequest({
        connectionId: seedB.connection.id,
        priceId: seedA.price.id,
        providerProductId: "prod_ok",
      }),
    );
    expect(crossApp.status).toBe(404);
    expect(((await crossApp.json()) as { code: string }).code).toBe(
      "connection_not_found",
    );

    // Wrong environment: live connection against the test console context.
    const liveApp = await createApplication(
      { slug: "clink-live", name: "CLink Live" },
      db,
    );
    const liveConnection = await createProviderConnection(
      {
        applicationId: liveApp.id,
        provider: "creem",
        name: "creem-live",
        mode: "live",
        credentials: { apiKey: "k", webhookSecret: "s" },
      },
      db,
    );
    const liveProduct = await createProduct(
      { applicationId: liveApp.id, key: "pro-live", name: "Pro" },
      db,
    );
    const livePrice = await createPrice(
      {
        applicationId: liveApp.id,
        productId: liveProduct.id,
        key: "default",
        currency: "USD",
        amountMinor: 1900,
        billingType: "one_time",
      },
      db,
    );
    selectedApplicationId = liveApp.id;
    const wrongEnv = await linkPOST(
      catalogLinksRequest({
        connectionId: liveConnection.id,
        priceId: livePrice.id,
        providerProductId: "prod_ok",
      }),
    );
    expect(wrongEnv.status).toBe(400);
    expect(((await wrongEnv.json()) as { code: string }).code).toBe(
      "connection_environment_mismatch",
    );
  });

  it("rejects revoked connections and archived prices", async () => {
    await seedOperator("owner");

    const revokedSeed = await seedCatalog("revoked");
    await revokeProviderConnection(
      revokedSeed.app.id,
      revokedSeed.connection.id,
      db,
    );
    const revoked = await linkProduct(revokedSeed);
    expect(revoked.status).toBe(400);
    expect(((await revoked.json()) as { code: string }).code).toBe(
      "connection_revoked",
    );

    const archivedSeed = await seedCatalog("price-arch");
    await db
      .update(pricesTable)
      .set({ status: "archived" })
      .where(eq(pricesTable.id, archivedSeed.price.id));
    const archived = await linkPOST(
      catalogLinksRequest({
        connectionId: archivedSeed.connection.id,
        priceId: archivedSeed.price.id,
        providerProductId: "prod_ok",
      }),
    );
    expect(archived.status).toBe(400);
    expect(((await archived.json()) as { code: string }).code).toBe(
      "price_inactive",
    );
  });

  it("denies operators without catalog:write and unauthenticated callers", async () => {
    await seedOperator("viewer");
    const seed = await seedCatalog("perm");

    const forbidden = await linkProduct(seed);
    expect(forbidden.status).toBe(403);
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);

    // Business mp_app_* credentials never authenticate an admin session —
    // the guard answers 401 before any body validation.
    mockAuth.mockResolvedValue(undefined as never);
    const unauthenticated = await linkProduct(seed);
    expect(unauthenticated.status).toBe(401);
  });
});

describe("checkout mapping precedence (#155)", () => {
  it("resolves persisted synced mappings before the adapter call and leaves unmapped prices to legacy behavior", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("precedence");

    const checkoutInput = (priceId: string) => ({
      applicationId: seed.app.id,
      monetplaneOrderId: `ord_${priceId}`,
      monetplaneCustomerId: "cus_1",
      billingMode: "one_time" as const,
      currency: "USD",
      items: [
        {
          productId: seed.product.id,
          priceId,
          quantity: 1,
          unitAmountMinor: 1900,
        },
      ],
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
    });

    // No mapping row: the adapter receives no providerProductId and falls
    // back to its own legacy catalog logic (unchanged behavior).
    await createProviderCheckout(
      seed.app.id,
      seed.connection.id,
      checkoutInput(seed.price.id),
      db,
    );
    expect(capturedCheckoutItems[0]?.providerProductId).toBeUndefined();

    // After a synced link, checkout resolves the product id from the table.
    const link = await linkProduct(seed);
    expect(link.status).toBe(201);
    await createProviderCheckout(
      seed.app.id,
      seed.connection.id,
      checkoutInput(seed.price.id),
      db,
    );
    expect(capturedCheckoutItems[1]?.providerProductId).toBe("prod_ok");

    // A non-synced row (e.g. a failed provisioning attempt from the #156
    // follow-up) never feeds checkout — resolution is synced-only.
    await db
      .update(providerCatalogMappings)
      .set({ status: "failed" })
      .where(eq(providerCatalogMappings.applicationId, seed.app.id));
    await createProviderCheckout(
      seed.app.id,
      seed.connection.id,
      checkoutInput(seed.price.id),
      db,
    );
    expect(capturedCheckoutItems[2]?.providerProductId).toBeUndefined();
  });
});
