import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as linkPOST } from "../../src/app/api/admin/providers/catalog-links/route";
import { POST as failIntentPOST } from "../../src/app/api/admin/providers/catalog-products/fail-intent/route";
import { POST as provisionPOST } from "../../src/app/api/admin/providers/catalog-products/route";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import { operatorAuditLog } from "../../src/modules/operations/audit-schema";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import {
  beginProvision,
  failNeedsReconciliationIntent,
  finishProvision,
} from "../../src/modules/providers/catalog-provisioning";
import type {
  CreateCatalogProductInput,
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
import { createProviderConnection } from "../../src/modules/providers/service";
import {
  acceptInvitation,
  findMembershipByEmail,
  inviteMember,
} from "../../src/modules/team/service";
import { provisionProviderCatalogProductFromConsole } from "../../src/server/control-plane/catalog-provisioning";
import { CONSOLE_APPLICATION_COOKIE } from "../../src/server/control-plane/context";

/**
 * Route-level integration for provider product provisioning (#156): real
 * admin guard + console context + database, with a configurable stub
 * "creem" adapter so every state-machine path is observable without
 * network access. Auth/cookie mocking mirrors provider-catalog-links.test.ts.
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
/** null → create succeeds with stubCreateId; otherwise thrown per call. */
let createBehavior:
  | { kind: "ok"; id: string }
  | { kind: "reject"; message: string; status?: number }
  | { kind: "uncertain"; message: string }
  | { kind: "rateLimitedTwice"; id: string };
let createCalls: CreateCatalogProductInput[];
let capturedCheckoutProductIds: Array<string | undefined>;

function defaultStubProduct(
  overrides: Record<string, unknown> = {},
): NormalizedProviderCatalogProduct {
  return {
    providerProductId: "prod_created",
    name: "Pro",
    status: "active",
    mode: "test",
    billingType: "one_time",
    amountMinor: 1900,
    currency: "USD",
    recurringInterval: null,
    intervalCount: null,
    taxCategory: null,
    ...overrides,
  } as NormalizedProviderCatalogProduct;
}

async function stubCreate(input: CreateCatalogProductInput) {
  createCalls.push(input);
  if (createBehavior.kind === "ok")
    return { providerProductId: createBehavior.id };
  if (createBehavior.kind === "rateLimitedTwice") {
    if (createCalls.length <= 2) {
      throw new ProviderOperationError(
        "Creem request failed (429 Too Many Requests)",
        "rejected",
        429,
      );
    }
    return { providerProductId: createBehavior.id };
  }
  if (createBehavior.kind === "reject") {
    throw new ProviderOperationError(
      createBehavior.message,
      "rejected",
      createBehavior.status,
    );
  }
  throw new ProviderOperationError(createBehavior.message, "outcome_uncertain");
}

const stubCreemAdapter: PaymentProviderAdapter = {
  ...mockProviderAdapter,
  provider: "creem",
  getCapabilities(connection) {
    return {
      ...mockProviderAdapter.getCapabilities(connection),
      catalog_provisioning: true,
    };
  },
  async getCatalogProduct(_connection, input) {
    if (
      !stubProduct ||
      stubProduct.providerProductId !== input.providerProductId
    ) {
      throw new ProviderOperationError(
        `Creem product not found: ${input.providerProductId}`,
        "rejected",
        404,
      );
    }
    return stubProduct;
  },
  async createCatalogProduct(_connection, input) {
    return stubCreate(input);
  },
  async createCheckout(_connection, input) {
    capturedCheckoutProductIds.push(
      ...input.items.map((item) => item.providerProductId),
    );
    return {
      providerCheckoutId: "ch_stub",
      checkoutUrl: "https://stub.test/ch_stub",
      reconciliationMetadata: {},
    };
  },
};

async function seedOperator(role: "owner" | "viewer") {
  const email = `prov-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { token } = await inviteMember({
    email,
    role,
    applicationScope: "all",
    applicationIds: [],
    invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
  });
  await acceptInvitation({
    token,
    name: "Provisioner",
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
    { slug: `prov-${suffix}`, name: `Prov ${suffix}` },
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

let selectedApplicationId: string | null;

function provisionRequest(body: unknown, path = "") {
  return new Request(
    `https://console.test/api/admin/providers/catalog-products${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
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

async function provision(
  seed: Awaited<ReturnType<typeof seedCatalog>>,
  extra: Record<string, unknown> = {},
) {
  return provisionPOST(
    provisionRequest({
      connectionId: seed.connection.id,
      priceId: seed.price.id,
      ...extra,
    }),
  );
}

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  stubProduct = defaultStubProduct();
  createBehavior = { kind: "ok", id: "prod_created" };
  createCalls = [];
  capturedCheckoutProductIds = [];
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
  await getSqlClient().end({ timeout: 1 });
});

describe("provider catalog provisioning (#156)", () => {
  it("creates a provider product, verifies it, and syncs the mapping for checkout", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("happy");

    const response = await provision(seed);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      outcome: string;
      providerProductId: string;
      mapping: { source: string; status: string };
    };
    expect(body.outcome).toBe("created");
    expect(body.providerProductId).toBe("prod_created");
    expect(body.mapping).toMatchObject({ source: "created", status: "synced" });

    const mappings = await mappingsFor(seed.app.id);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      providerProductId: "prod_created",
      source: "created",
      status: "synced",
    });
    // Idempotency key is the mapping row id — stable across retries.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.idempotencyKey).toBe(mappings[0]?.id);
    expect(createCalls[0]).toMatchObject({
      name: `Pro happy`,
      amountMinor: 1900,
      currency: "USD",
      billingType: "one_time",
    });

    // The created mapping feeds checkout (synced-only resolution).
    await createProviderCheckout(
      seed.app.id,
      seed.connection.id,
      {
        applicationId: seed.app.id,
        monetplaneOrderId: "ord_prov_1",
        monetplaneCustomerId: "cus_1",
        billingMode: "one_time",
        currency: "USD",
        items: [
          {
            productId: seed.product.id,
            priceId: seed.price.id,
            quantity: 1,
            unitAmountMinor: 1900,
          },
        ],
        successUrl: "https://app.example/success",
        cancelUrl: "https://app.example/cancel",
      },
      db,
    );
    expect(capturedCheckoutProductIds[0]).toBe("prod_created");

    const entries = await auditFor(seed.app.id);
    expect(entries.map((entry) => entry.action)).toEqual([
      "provider_catalog.provisioned",
    ]);
  });

  it("returns the existing mapping read-only for an already-synced price and never re-creates", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("idem");

    const first = await provision(seed);
    expect(first.status).toBe(201);
    const second = await provision(seed);

    expect(second.status).toBe(200);
    const body = (await second.json()) as { outcome: string };
    expect(body.outcome).toBe("already_synced");
    expect(createCalls).toHaveLength(1);
    expect(await mappingsFor(seed.app.id)).toHaveLength(1);
  });

  it("parks deterministic rejections as failed and allows an explicit retry", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("rejected");
    createBehavior = {
      kind: "reject",
      message: "Creem rejected the product payload",
      status: 422,
    };

    const rejected = await provision(seed);
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe(
      "provision_create_rejected",
    );
    let mappings = await mappingsFor(seed.app.id);
    expect(mappings[0]).toMatchObject({
      status: "failed",
      providerProductId: null,
    });

    // Retry: adapter healthy again — same intent row, same idempotency key.
    createBehavior = { kind: "ok", id: "prod_created" };
    const retried = await provision(seed);
    expect(retried.status).toBe(201);
    mappings = await mappingsFor(seed.app.id);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      status: "synced",
      providerProductId: "prod_created",
    });
    expect(new Set(createCalls.map((call) => call.idempotencyKey)).size).toBe(
      1,
    );

    // outcome audit (failed) + validation-stage audit (rejected) + provisioned
    const entries = await auditFor(seed.app.id);
    expect([...entries.map((entry) => entry.action)].sort()).toEqual(
      [
        "provider_catalog.provisioned",
        "provider_catalog.provision_failed",
      ].sort(),
    );
  });

  it("parks uncertain outcomes as needs_reconciliation without auto-retrying and supports adoption", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("uncertain");
    createBehavior = { kind: "uncertain", message: "Creem request timed out" };

    const uncertain = await provision(seed);
    expect(uncertain.status).toBe(409);
    expect(((await uncertain.json()) as { code: string }).code).toBe(
      "provision_needs_attention",
    );
    // Exactly ONE create attempt — uncertain outcomes are never re-POSTed.
    expect(createCalls).toHaveLength(1);
    const mappings = await mappingsFor(seed.app.id);
    expect(mappings[0]).toMatchObject({
      status: "needs_reconciliation",
      providerProductId: null,
    });

    // A second provision refuses until the operator recovers the intent.
    createBehavior = { kind: "ok", id: "prod_other" };
    const blocked = await provision(seed);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe(
      "provision_needs_attention",
    );
    expect(createCalls).toHaveLength(1);

    // Recovery: the operator found the product at the provider and links it.
    stubProduct = defaultStubProduct({ providerProductId: "prod_found" });
    const adopted = await linkPOST(
      new Request("https://console.test/api/admin/providers/catalog-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: seed.connection.id,
          priceId: seed.price.id,
          providerProductId: "prod_found",
        }),
      }),
    );
    expect(adopted.status).toBe(200);
    expect(((await adopted.json()) as { outcome: string }).outcome).toBe(
      "recovered",
    );
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({
        status: "synced",
        providerProductId: "prod_found",
        source: "created",
      }),
    ]);

    const entries = await auditFor(seed.app.id);
    expect([...entries.map((entry) => entry.action)].sort()).toEqual(
      [
        "provider_catalog.recovered",
        "provider_catalog.provision_uncertain",
        "provider_catalog.provision_rejected",
      ].sort(),
    );
  });

  it("supports mark-failed recovery and retries with the stable idempotency key", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("failintent");
    createBehavior = { kind: "uncertain", message: "connection reset" };
    await provision(seed);

    const failed = await failIntentPOST(
      provisionRequest(
        { connectionId: seed.connection.id, priceId: seed.price.id },
        "/fail-intent",
      ),
    );
    expect(failed.status).toBe(200);
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({ status: "failed", providerProductId: null }),
    ]);

    createBehavior = { kind: "ok", id: "prod_retry_ok" };
    stubProduct = defaultStubProduct({ providerProductId: "prod_retry_ok" });
    const retried = await provision(seed);
    expect(retried.status).toBe(201);
    const keys = createCalls.map((call) => call.idempotencyKey);
    expect(new Set(keys).size).toBe(1);

    const entries = await auditFor(seed.app.id);
    expect(entries.map((entry) => entry.action)).toContain(
      "provider_catalog.intent_failed",
    );
    expect(entries.map((entry) => entry.action)).toContain(
      "provider_catalog.provisioned",
    );
  });

  it("retries 429 rate limits with backoff and the same idempotency key (orchestration-level)", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("ratelimit");
    createBehavior = { kind: "rateLimitedTwice", id: "prod_after_429" };
    stubProduct = defaultStubProduct({ providerProductId: "prod_after_429" });

    const result = await provisionProviderCatalogProductFromConsole(
      seed.app.id,
      "test",
      {
        providerConnectionId: seed.connection.id,
        monetplanePriceId: seed.price.id,
      },
      async () => {},
      { retryDelaysMs: [1, 1] },
    );

    expect(result.outcome).toBe("created");
    expect(createCalls).toHaveLength(3);
    expect(new Set(createCalls.map((call) => call.idempotencyKey)).size).toBe(
      1,
    );
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({
        status: "synced",
        providerProductId: "prod_after_429",
      }),
    ]);
  });

  it("refuses while a fresh intent is in flight and parks crashed attempts as needs_reconciliation", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("inflight");

    // Fresh pending row (simulating a concurrently running attempt).
    await db.insert(providerCatalogMappings).values({
      id: "pcmap_inflight_manual",
      applicationId: seed.app.id,
      providerConnectionId: seed.connection.id,
      environment: "test",
      monetplanePriceId: seed.price.id,
      provider: "creem",
      providerProductId: null,
      source: "created",
      status: "pending",
      verifiedSnapshot: {},
    });

    const inFlight = await provision(seed);
    expect(inFlight.status).toBe(409);
    expect(((await inFlight.json()) as { code: string }).code).toBe(
      "provision_in_progress",
    );
    expect(createCalls).toHaveLength(0);

    // Stale creating row (crashed attempt 10 minutes ago) is parked.
    await db
      .update(providerCatalogMappings)
      .set({
        status: "creating",
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .where(eq(providerCatalogMappings.id, "pcmap_inflight_manual"));
    const stale = await provision(seed);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe(
      "provision_needs_attention",
    );
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({ status: "needs_reconciliation" }),
    ]);
    const entries = await auditFor(seed.app.id);
    expect(entries.map((entry) => entry.action)).toContain(
      "provider_catalog.provision_stale",
    );
  });

  it("parks a post-create verification mismatch with the created id and refuses the mismatched product", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("mismatch");
    createBehavior = { kind: "ok", id: "prod_wrong_shape" };
    stubProduct = defaultStubProduct({
      providerProductId: "prod_wrong_shape",
      amountMinor: 9900,
    });

    const response = await provision(seed);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe(
      "provision_post_create_mismatch",
    );
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({
        status: "needs_reconciliation",
        providerProductId: "prod_wrong_shape",
      }),
    ]);
  });

  it("refuses provisioning when a legacy metadata mapping already covers the price", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("legacy");

    await db
      .update(providerConnections)
      .set({ metadata: { catalog: { [seed.price.id]: "prod_legacy" } } })
      .where(eq(providerConnections.id, seed.connection.id));

    const response = await provision(seed);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "legacy_mapping_conflict",
    );
    expect(createCalls).toHaveLength(0);
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);
  });

  it("keeps the synced no-rebind guarantee from #158", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("norebind");
    await provision(seed);
    stubProduct = defaultStubProduct({ providerProductId: "prod_other" });

    const response = await linkPOST(
      new Request("https://console.test/api/admin/providers/catalog-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: seed.connection.id,
          priceId: seed.price.id,
          providerProductId: "prod_other",
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({ providerProductId: "prod_created" }),
    ]);
  });

  it("denies operators without catalog:write and unauthenticated callers", async () => {
    await seedOperator("viewer");
    const seed = await seedCatalog("perm");

    const forbidden = await provision(seed);
    expect(forbidden.status).toBe(403);
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);

    mockAuth.mockResolvedValue(undefined as never);
    const unauthenticated = await provision(seed);
    expect(unauthenticated.status).toBe(401);
  });

  it("refuses fail-intent on any state other than needs_reconciliation", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("failrefuse");

    // No row at all.
    const none = await failIntentPOST(
      provisionRequest(
        { connectionId: seed.connection.id, priceId: seed.price.id },
        "/fail-intent",
      ),
    );
    expect(none.status).toBe(409);

    // Synced row must not be resettable either.
    await provision(seed);
    const synced = await failIntentPOST(
      provisionRequest(
        { connectionId: seed.connection.id, priceId: seed.price.id },
        "/fail-intent",
      ),
    );
    expect(synced.status).toBe(409);
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({ status: "synced" }),
    ]);
  });

  it("parks exhausted 429 retries as failed, not needs_reconciliation", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("ratelimited");
    // Always 429 — the bounded retries exhaust.
    let calls = 0;
    const exhaustingAdapter: PaymentProviderAdapter = {
      ...stubCreemAdapter,
      async createCatalogProduct(_connection, input) {
        calls += 1;
        createCalls.push(input);
        throw new ProviderOperationError(
          "Creem request failed (429 Too Many Requests)",
          "rejected",
          429,
        );
      },
    };
    clearProviderAdaptersForTests();
    registerProviderAdapter(exhaustingAdapter);

    const response = await provision(seed);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "provision_create_rejected",
    );
    // Initial call + both bounded retries.
    expect(calls).toBe(3);
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({ status: "failed", providerProductId: null }),
    ]);
  });

  it("passes operator name and tax category overrides through to the create body", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("overrides");

    const response = await provision(seed, {
      name: "Custom name",
      description: "Custom description",
      taxCategory: "digital-goods-service",
    });

    expect(response.status).toBe(201);
    expect(createCalls[0]).toMatchObject({
      name: "Custom name",
      description: "Custom description",
      taxCategory: "digital-goods-service",
    });
  });

  it("ABA guard: a late finish from a superseded attempt cannot touch a re-claimed row", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("aba");

    // Attempt 1 claims the intent.
    const first = await beginProvision(
      {
        applicationId: seed.app.id,
        environment: "test",
        providerConnectionId: seed.connection.id,
        monetplanePriceId: seed.price.id,
      },
      db,
    );
    if (first.outcome !== "begin") throw new Error("expected begin");

    // Crash + operator recovery: stale-park (simulated directly), then
    // fail-intent, then attempt 2 re-claims the SAME row.
    await db
      .update(providerCatalogMappings)
      .set({ status: "needs_reconciliation" })
      .where(eq(providerCatalogMappings.id, first.mapping.id));
    await failNeedsReconciliationIntent(
      {
        applicationId: seed.app.id,
        environment: "test",
        providerConnectionId: seed.connection.id,
        monetplanePriceId: seed.price.id,
      },
      db,
    );
    const second = await beginProvision(
      {
        applicationId: seed.app.id,
        environment: "test",
        providerConnectionId: seed.connection.id,
        monetplanePriceId: seed.price.id,
      },
      db,
    );
    if (second.outcome !== "begin") throw new Error("expected second begin");
    expect(second.attemptToken).not.toBe(first.attemptToken);

    // Attempt 1's HTTP finally resolves and tries to finish — with the OLD
    // token it must be refused without touching attempt 2's row.
    stubProduct = defaultStubProduct({ providerProductId: "prod_late_first" });
    await expect(
      finishProvision(
        {
          applicationId: seed.app.id,
          environment: "test",
          providerConnectionId: seed.connection.id,
          monetplanePriceId: seed.price.id,
          mappingId: first.mapping.id,
          attemptToken: first.attemptToken,
        },
        { kind: "created", providerProductId: "prod_late_first" },
        async (id) => {
          const lookup = stubCreemAdapter.getCatalogProduct;
          if (!lookup) throw new Error("stub lookup missing");
          return lookup({} as never, { providerProductId: id });
        },
        db,
      ),
    ).rejects.toThrow(/no longer in a state/i);
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({
        status: "creating",
        providerProductId: null,
      }),
    ]);

    // Attempt 2 completes normally with ITS token.
    stubProduct = defaultStubProduct({ providerProductId: "prod_second" });
    const finish = await finishProvision(
      {
        applicationId: seed.app.id,
        environment: "test",
        providerConnectionId: seed.connection.id,
        monetplanePriceId: seed.price.id,
        mappingId: second.mapping.id,
        attemptToken: second.attemptToken,
      },
      { kind: "created", providerProductId: "prod_second" },
      async (id) => {
        const lookup = stubCreemAdapter.getCatalogProduct;
        if (!lookup) throw new Error("stub lookup missing");
        return lookup({} as never, { providerProductId: id });
      },
      db,
    );
    expect(finish.outcome).toBe("synced");
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({
        status: "synced",
        providerProductId: "prod_second",
      }),
    ]);
  });

  it("a late created-id still lands on its OWN needs_reconciliation row (matching token)", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("lateid");

    const first = await beginProvision(
      {
        applicationId: seed.app.id,
        environment: "test",
        providerConnectionId: seed.connection.id,
        monetplanePriceId: seed.price.id,
      },
      db,
    );
    if (first.outcome !== "begin") throw new Error("expected begin");

    // The attempt goes stale in-flight and is parked — token preserved.
    await db
      .update(providerCatalogMappings)
      .set({ status: "needs_reconciliation" })
      .where(eq(providerCatalogMappings.id, first.mapping.id));

    // The POST eventually succeeded; the id must be persisted for adoption.
    // Verification read fails here (product unknown yet) → stays NR WITH id.
    stubProduct = null;
    const finish = await finishProvision(
      {
        applicationId: seed.app.id,
        environment: "test",
        providerConnectionId: seed.connection.id,
        monetplanePriceId: seed.price.id,
        mappingId: first.mapping.id,
        attemptToken: first.attemptToken,
      },
      { kind: "created", providerProductId: "prod_late" },
      async () => {
        throw new Error("lookup failed");
      },
      db,
    );
    expect(finish.outcome).toBe("uncertain");
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({
        status: "needs_reconciliation",
        providerProductId: "prod_late",
      }),
    ]);
  });

  it("freezes the intent parameters at first claim and rejects divergent retries (F2)", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("freeze");
    createBehavior = {
      kind: "reject",
      message: "422 unprocessable",
      status: 422,
    };

    const first = await provision(seed, { name: "Original name" });
    expect(first.status).toBe(400);
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({ status: "failed" }),
    ]);

    // Divergent retry: different name -> rejected before any create call.
    createCalls = [];
    createBehavior = { kind: "ok", id: "prod_after" };
    stubProduct = defaultStubProduct({ providerProductId: "prod_after" });
    const divergent = await provision(seed, { name: "Changed name" });
    expect(divergent.status).toBe(400);
    expect(((await divergent.json()) as { code: string }).code).toBe(
      "invalid_input",
    );
    expect(createCalls).toHaveLength(0);

    // Identical retry proceeds and syncs.
    const identical = await provision(seed, { name: "Original name" });
    expect(identical.status).toBe(201);
    expect(await mappingsFor(seed.app.id)).toMatchObject([
      expect.objectContaining({ status: "synced" }),
    ]);
  });

  it("audits a post-create mismatch as uncertain, not rejected (F3)", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("mmaudit");
    createBehavior = { kind: "ok", id: "prod_wrong" };
    stubProduct = defaultStubProduct({
      providerProductId: "prod_wrong",
      amountMinor: 9900,
    });

    const response = await provision(seed);
    expect(response.status).toBe(409);

    const entries = await auditFor(seed.app.id);
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("provider_catalog.provision_uncertain");
    expect(actions).not.toContain("provider_catalog.provision_rejected");
  });

  it("answers a JSON null body on fail-intent with 400, not 500 (F4)", async () => {
    await seedOperator("owner");
    const seed = await seedCatalog("nullbody");

    const response = await failIntentPOST(
      new Request(
        "https://console.test/api/admin/providers/catalog-products/fail-intent",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
        },
      ),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "invalid_input",
    );
    expect(await mappingsFor(seed.app.id)).toHaveLength(0);
  });
});
