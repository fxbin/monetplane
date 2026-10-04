import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as creditsPOST } from "../../src/app/api/admin/customers/[customerId]/credits/route";
import { getDb } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { creditTransactions } from "../../src/modules/credits/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { operatorAuditLog } from "../../src/modules/operations/audit-schema";
import {
  acceptInvitation,
  findMembershipByEmail,
  inviteMember,
} from "../../src/modules/team/service";
import { setupIntegrationFile } from "./test-setup";

/**
 * Admin credit-grant route (audit M5/M6):
 * - a client-supplied idempotencyKey makes operator-grant retries resolve to
 *   the same ledger entry instead of double-crediting;
 * - the amount field is strictly a number (no string coercion).
 *
 * NextAuth session and cookies are mocked (team-access.test.ts pattern);
 * membership data stays real in the database.
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

// Shared per-file setup (roundtable batch 1): test encryption key + SQL
// client teardown, replacing this file's hand-rolled afterAll.
setupIntegrationFile();

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedOperatorAndCustomer(slugSeed: string) {
  const email = `credits-admin-${slugSeed}@example.test`;
  const { token } = await inviteMember({
    email,
    role: "owner",
    applicationScope: "all",
    applicationIds: [],
    invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
  });
  await acceptInvitation({
    token,
    name: "Credits Admin",
    password: "must(sup3rsecret)",
  });
  const membership = await findMembershipByEmail(email);
  if (!membership) throw new Error("membership missing after accept");

  mockAuth.mockResolvedValue({
    user: { id: membership.operatorId },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as never);
  mockCookies.mockResolvedValue({ get: () => undefined } as never);

  const app = await createApplication(
    { slug: `credits-${slugSeed}`, name: "Credits" },
    db,
  );
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1" },
    db,
  );
  return { app, customer, operatorId: membership.operatorId };
}

function postCredits(
  customerId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return creditsPOST(
    new Request(
      `https://console.test/api/admin/customers/${customerId}/credits`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
    ),
    { params: Promise.resolve({ customerId }) },
  );
}

async function adminGrantRows(applicationCustomerId: string) {
  return db
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.applicationCustomerId, applicationCustomerId),
        eq(creditTransactions.type, "adjustment.admin"),
      ),
    );
}

describe("admin credit-grant idempotency and amount strictness (M5/M6)", () => {
  it("resolves a retried grant with the same idempotencyKey to one ledger entry", async () => {
    const { app, customer } = await seedOperatorAndCustomer(
      Math.random().toString(36).slice(2, 8),
    );

    const body = {
      creditType: "generation",
      amount: 250,
      note: "support adjustment",
      idempotencyKey: "ticket-4187",
    };
    const first = await postCredits(customer.id, body);
    expect(first.status).toBe(200);
    const second = await postCredits(customer.id, body);
    expect(second.status).toBe(200);

    const rows = await adminGrantRows(customer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 250, sourceType: "admin" });

    const firstJson = await first.json();
    const secondJson = await second.json();
    expect(secondJson.transaction.id).toBe(firstJson.transaction.id);
    expect(app.id).toBeTruthy();
  });

  it("keeps distinct keys as distinct grants", async () => {
    const { customer } = await seedOperatorAndCustomer(
      Math.random().toString(36).slice(2, 8),
    );

    await postCredits(customer.id, {
      creditType: "generation",
      amount: 10,
      idempotencyKey: "ticket-a",
    });
    await postCredits(customer.id, {
      creditType: "generation",
      amount: 10,
      idempotencyKey: "ticket-b",
    });

    const rows = await adminGrantRows(customer.id);
    expect(rows).toHaveLength(2);
  });

  it("rejects string amounts instead of coercing (M6)", async () => {
    const { customer } = await seedOperatorAndCustomer(
      Math.random().toString(36).slice(2, 8),
    );

    const response = await postCredits(customer.id, {
      creditType: "generation",
      amount: "5",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Amount must be a positive whole number",
    });
    expect(await adminGrantRows(customer.id)).toHaveLength(0);
  });

  it("still grants without an idempotencyKey (legacy callers)", async () => {
    const { customer } = await seedOperatorAndCustomer(
      Math.random().toString(36).slice(2, 8),
    );

    const response = await postCredits(customer.id, {
      creditType: "generation",
      amount: 50,
    });

    expect(response.status).toBe(200);
    const rows = await adminGrantRows(customer.id);
    expect(rows).toHaveLength(1);
  });

  it("writes the grant audit row in the grant's transaction (roundtable batch 1)", async () => {
    const { app, customer, operatorId } = await seedOperatorAndCustomer(
      Math.random().toString(36).slice(2, 8),
    );

    const response = await postCredits(customer.id, {
      creditType: "generation",
      amount: 120,
      idempotencyKey: "audit-tx-1",
    });
    expect(response.status).toBe(200);
    const { transaction } = (await response.json()) as {
      transaction: { id: string };
    };

    // The audit entry must reference the ledger row, the acting operator,
    // and the granted amount — written atomically with the transaction.
    const [audit] = await db
      .select()
      .from(operatorAuditLog)
      .where(
        and(
          eq(operatorAuditLog.applicationId, app.id),
          eq(operatorAuditLog.action, "credits.granted"),
        ),
      )
      .limit(1);
    expect(audit).toMatchObject({
      resourceId: transaction.id,
      actorId: operatorId,
      actorType: "admin_session",
    });
    expect(audit?.metadata).toMatchObject({
      customerId: customer.id,
      amount: 120,
      creditType: "generation",
    });
  });
});
