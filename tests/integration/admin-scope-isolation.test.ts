import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GET as adminCustomersGET } from "../../src/app/api/admin/customers/route";
import { GET as adminOverviewGET } from "../../src/app/api/admin/overview/route";
import { GET as adminProductsGET } from "../../src/app/api/admin/products/route";
import { GET as adminProvidersGET } from "../../src/app/api/admin/providers/route";
import { getDb, getSqlClient } from "../../src/db/client";
import { requireAdmin } from "../../src/modules/admin/guard";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import { createProduct } from "../../src/modules/catalog/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { createProviderConnection } from "../../src/modules/providers/service";
import { operators, workspaceMembers } from "../../src/modules/team/schema";
import {
  acceptInvitation,
  authenticateWithBootstrap,
  findMembershipByEmail,
  inviteMember,
  removeMember,
} from "../../src/modules/team/service";
import {
  createTestWebhookDelivery,
  createWebhookEndpoint,
} from "../../src/modules/webhooks/service";
import { enableTestEncryption } from "./test-setup";

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

beforeEach(() => {
  enableTestEncryption();
  mockAuth.mockReset();
  mockCookies.mockResolvedValue({ get: () => undefined } as never);
  delete process.env.ADMIN_PASSWORD;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  await getSqlClient().end({ timeout: 1 });
});

describe("admin scope isolation & team hardening", () => {
  it("fails closed on admin GET routes when a restricted member has no active selected application", async () => {
    const appHidden = await createApplication(
      { slug: "app-hidden", name: "Hidden App" },
      db,
    );
    const appSuspended = await createApplication(
      { slug: "app-suspended", name: "Suspended App" },
      db,
    );

    // Populate data in appHidden that the restricted user must NEVER see.
    await createApplicationCustomer(
      {
        applicationId: appHidden.id,
        externalCustomerId: "secret-cust",
        email: "secret@example.test",
      },
      db,
    );
    await createProduct(
      { applicationId: appHidden.id, key: "secret-prod", name: "Secret Prod" },
      db,
    );
    await createProviderConnection(
      {
        applicationId: appHidden.id,
        provider: "mock",
        name: "Secret Provider",
        mode: "test",
        credentials: { webhookSecret: "secret-wh" },
      },
      db,
    );

    // Deactivate the only project assigned to the restricted user so
    // getConsoleContext().selectedApplication resolves to null.
    await db
      .update(applications)
      .set({ status: "suspended" })
      .where(eq(applications.id, appSuspended.id));

    const { token } = await inviteMember({
      email: "restricted-empty@example.test",
      role: "developer",
      applicationScope: "restricted",
      applicationIds: [appSuspended.id],
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await acceptInvitation({ token, password: "must(sup3rsecret)" });
    const membership = await findMembershipByEmail(
      "restricted-empty@example.test",
    );
    expect(membership).not.toBeNull();

    mockAuth.mockResolvedValue({
      user: {
        id: membership?.operatorId,
        role: "developer",
        credentialVersion: membership?.operatorCredentialVersion,
      },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    } as never);

    const overviewRes = await adminOverviewGET();
    expect(overviewRes.status).toBe(200);
    await expect(overviewRes.json()).resolves.toMatchObject({
      stats: {
        applications: 0,
        products: 0,
        customers: 0,
        activeProviders: 0,
        orders: 0,
        totalRevenueMinor: 0,
        creditTransactions: 0,
      },
      recentOrders: [],
    });

    const customersRes = await adminCustomersGET();
    expect(customersRes.status).toBe(200);
    await expect(customersRes.json()).resolves.toMatchObject({
      customers: [],
    });

    const providersRes = await adminProvidersGET();
    expect(providersRes.status).toBe(200);
    await expect(providersRes.json()).resolves.toMatchObject({
      providers: [],
    });

    const productsRes = await adminProductsGET();
    expect(productsRes.status).toBe(200);
    await expect(productsRes.json()).resolves.toMatchObject({
      products: [],
    });
  });

  it("increments credentialVersion when re-inviting a removed operator so old JWTs stay invalid", async () => {
    const email = "reinvited-op@example.test";
    const firstInvite = await inviteMember({
      email,
      role: "support",
      applicationScope: "all",
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await acceptInvitation({
      token: firstInvite.token,
      password: "first-password-123",
    });

    const firstMembership = await findMembershipByEmail(email);
    expect(firstMembership?.operatorCredentialVersion).toBe(0);
    if (!firstMembership) throw new Error("membership missing");

    await removeMember({
      memberId: firstMembership.memberId,
      removedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });

    const secondInvite = await inviteMember({
      email,
      role: "support",
      applicationScope: "all",
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await acceptInvitation({
      token: secondInvite.token,
      password: "second-password-123",
    });

    const secondMembership = await findMembershipByEmail(email);
    expect(secondMembership?.operatorCredentialVersion).toBe(1);

    // Pre-removal JWT with credentialVersion: 0 must be rejected.
    mockAuth.mockResolvedValue({
      user: {
        id: secondMembership?.operatorId,
        role: "support",
        credentialVersion: 0,
      },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    } as never);
    const staleRes = await requireAdmin();
    expect(staleRes).toBeInstanceOf(Response);
    expect((staleRes as Response).status).toBe(401);

    // New JWT with credentialVersion: 1 passes.
    mockAuth.mockResolvedValue({
      user: {
        id: secondMembership?.operatorId,
        role: "support",
        credentialVersion: 1,
      },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    } as never);
    const freshRes = await requireAdmin();
    expect(freshRes).not.toBeInstanceOf(Response);
  });

  it("serializes concurrent first-login owner bootstrap so only one owner can be created", async () => {
    process.env.ADMIN_PASSWORD = "bootstrap-secret-value";

    const [a, b] = await Promise.all([
      authenticateWithBootstrap({
        email: "owner-one@example.test",
        password: "bootstrap-secret-value",
      }),
      authenticateWithBootstrap({
        email: "owner-two@example.test",
        password: "bootstrap-secret-value",
      }),
    ]);

    const successes = [a, b].filter(Boolean);
    expect(successes).toHaveLength(1);

    const allOwners = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.role, "owner"));
    const allOperators = await db.select().from(operators);
    expect(allOwners).toHaveLength(1);
    expect(allOperators).toHaveLength(1);
  });

  it("enforces redirect:error and blocks DNS rebinding during outbound webhook delivery", async () => {
    const app = await createApplication(
      { slug: "wh-ssrf-delivery", name: "Webhook SSRF Delivery" },
      db,
    );
    const endpoint = await createWebhookEndpoint(
      app.id,
      "live",
      { name: "Prod Hook", url: "https://hooks.public.test/cb" },
      db,
    );

    // DNS rebinding to metadata IP fails closed before fetch is ever invoked.
    let fetchCalled = false;
    const rebindResult = await createTestWebhookDelivery(
      app.id,
      "live",
      endpoint.id,
      {
        lookupImpl: async () => [{ address: "169.254.169.254", family: 4 }],
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response("ok", { status: 200 });
        },
      },
      db,
    );
    expect(fetchCalled).toBe(false);
    expect(rebindResult.status).toBe("failed");
    expect(rebindResult.errorMessage).toContain(
      "private, loopback, or internal",
    );

    // Valid public DNS passes and sets redirect: "error" on fetch init.
    let capturedRedirect: RequestInit["redirect"];
    const okResult = await createTestWebhookDelivery(
      app.id,
      "live",
      endpoint.id,
      {
        lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async (_url, init) => {
          capturedRedirect = init?.redirect;
          return new Response("ok", { status: 200 });
        },
      },
      db,
    );
    expect(okResult.status).toBe("succeeded");
    expect(capturedRedirect).toBe("error");
  });
});
