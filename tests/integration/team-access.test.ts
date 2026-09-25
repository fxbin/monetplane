import { and, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  requireAdmin,
  requireApplicationAccess,
  requirePermission,
} from "../../src/modules/admin/guard";
import { createApplication } from "../../src/modules/applications/service";
import { operatorAuditLog } from "../../src/modules/operations/audit-schema";
import type { WorkspaceRole } from "../../src/modules/team/permissions";
import { operatorInvitations, operators } from "../../src/modules/team/schema";
import {
  acceptInvitation,
  authenticateWithBootstrap,
  findMembershipByEmail,
  inviteMember,
  listTeamOverview,
  removeMember,
  revokeInvitation,
  TeamServiceError,
  updateMember,
} from "../../src/modules/team/service";

/**
 * Team workspace, roles, and least-privilege admin access (#70).
 *
 * Guard authorization is exercised with a mocked NextAuth session so the
 * tests prove the fail-closed properties directly: the session JWT is only
 * an identity claim — role/membership/scope come from the database.
 */

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

const { auth } = await import("@/auth");
const mockAuth = vi.mocked(auth);

const db = getDb();

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

beforeEach(() => {
  mockAuth.mockReset();
  delete process.env.ADMIN_PASSWORD;
});

let operatorSeq = 0;

function uniqueEmail(prefix: string) {
  operatorSeq += 1;
  return `${prefix}-${operatorSeq}-${Math.random()
    .toString(36)
    .slice(2, 8)}@example.test`;
}

function sessionFor(operatorId: string) {
  mockAuth.mockResolvedValue({
    user: { id: operatorId, role: "owner" },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as never);
}

async function createMember(email: string, role: WorkspaceRole) {
  const { token } = await inviteMember({
    email,
    role,
    applicationScope: "all",
    applicationIds: [],
    invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
  });
  await acceptInvitation({
    token,
    name: email.split("@")[0],
    password: "must(sup3rsecret)",
  });
  const membership = await findMembershipByEmail(email);
  if (!membership) throw new Error("membership missing after accept");
  return membership;
}

async function lastAuditAction(action: string) {
  const [entry] = await db
    .select()
    .from(operatorAuditLog)
    .where(
      and(
        eq(operatorAuditLog.action, action),
        isNull(operatorAuditLog.applicationId),
      ),
    )
    .orderBy(desc(operatorAuditLog.createdAt))
    .limit(1);
  return entry;
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected value to be present in test");
  }
  return value;
}

function guardStatus(result: unknown): number {
  expect(result).toBeInstanceOf(NextResponse);
  return (result as NextResponse).status;
}

describe("first-owner bootstrap (#70)", () => {
  it("provisions the first owner from ADMIN_PASSWORD, then closes the path", async () => {
    process.env.ADMIN_PASSWORD = "bootstrap-secret";
    const email = uniqueEmail("founder");

    const operator = await authenticateWithBootstrap({
      email,
      password: "bootstrap-secret",
    });
    expect(operator?.role).toBe("owner");

    const audited = await lastAuditAction("team.owner_bootstrapped");
    expect(audited?.metadata).toMatchObject({ email });

    // Bootstrap is one-shot: with any operator existing it is closed.
    await expect(
      authenticateWithBootstrap({
        email: uniqueEmail("latecomer"),
        password: "bootstrap-secret",
      }),
    ).resolves.toBeNull();

    // The provisioned owner signs in with their own scrypt-hashed credential.
    await expect(
      authenticateWithBootstrap({ email, password: "wrong" }),
    ).resolves.toBeNull();
    await expect(
      authenticateWithBootstrap({ email, password: "bootstrap-secret" }),
    ).resolves.toMatchObject({ role: "owner" });
  });

  it("rejects bootstrap when ADMIN_PASSWORD is unset or wrong", async () => {
    // No operators exist yet in this test (fresh truncate), but no env secret.
    await expect(
      authenticateWithBootstrap({
        email: uniqueEmail("nosecret"),
        password: "whatever",
      }),
    ).resolves.toBeNull();

    process.env.ADMIN_PASSWORD = "bootstrap-secret";
    await expect(
      authenticateWithBootstrap({
        email: uniqueEmail("badsecret"),
        password: "not-the-secret",
      }),
    ).resolves.toBeNull();
  });
});

describe("invitation and membership lifecycle", () => {
  it("invites, accepts, and audits the full flow", async () => {
    const email = uniqueEmail("dev");
    const { invitationId, token, expiresAt } = await inviteMember({
      email,
      role: "developer",
      applicationScope: "restricted",
      applicationIds: [
        await createApplication({
          slug: `team-${Math.random().toString(36).slice(2, 8)}`,
          name: "Team App",
        }).then((a) => a.id),
      ],
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Only the SHA-256 hash is stored — the raw token never hits the database.
    const [invitationRow] = await db
      .select()
      .from(operatorInvitations)
      .where(eq(operatorInvitations.id, invitationId));
    expect(invitationRow.status).toBe("pending");
    expect(invitationRow.tokenHash).not.toBe(token);
    expect(invitationRow.tokenHash).toHaveLength(64);

    const audited = await lastAuditAction("team.invitation_created");
    expect(audited?.metadata).toMatchObject({ email, role: "developer" });

    const result = await acceptInvitation({
      token,
      name: "Dee Veloper",
      password: "must(sup3rsecret)",
    });
    expect(result.email).toBe(email);

    const membership = await findMembershipByEmail(email);
    expect(membership).toMatchObject({
      role: "developer",
      applicationScope: "restricted",
      operatorStatus: "active",
    });
    expect(membership?.applicationIds).toHaveLength(1);

    const joined = await lastAuditAction("team.member_joined");
    expect(joined?.metadata).toMatchObject({ email, role: "developer" });

    // The token cannot be redeemed twice.
    await expect(
      acceptInvitation({ token, name: "Again", password: "must(sup3rsecret)" }),
    ).rejects.toMatchObject({ code: "invitation_invalid" });
  });

  it("rejects weak passwords, duplicate members, and stacked invitations", async () => {
    const email = uniqueEmail("dup");
    const { token } = await inviteMember({
      email,
      role: "viewer",
      applicationScope: "all",
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });

    await expect(
      acceptInvitation({ token, password: "short" }),
    ).rejects.toMatchObject({ code: "invalid_password" });

    // Pending invitation blocks a second one for the same email…
    await expect(
      inviteMember({
        email,
        role: "viewer",
        applicationScope: "all",
        invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
      }),
    ).rejects.toMatchObject({ code: "invitation_pending" });

    await acceptInvitation({ token, password: "must(sup3rsecret)" });

    // …and an active member blocks re-inviting the same email.
    await expect(
      inviteMember({
        email,
        role: "viewer",
        applicationScope: "all",
        invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
      }),
    ).rejects.toMatchObject({ code: "already_member" });
  });

  it("expires and revokes invitations", async () => {
    const email = uniqueEmail("expiry");
    const { invitationId, token } = await inviteMember({
      email,
      role: "support",
      applicationScope: "all",
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });

    await db
      .update(operatorInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(operatorInvitations.id, invitationId));
    await expect(
      acceptInvitation({ token, password: "must(sup3rsecret)" }),
    ).rejects.toMatchObject({ code: "invitation_invalid" });

    const email2 = uniqueEmail("revoke");
    const invite2 = await inviteMember({
      email: email2,
      role: "support",
      applicationScope: "all",
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await revokeInvitation({
      invitationId: invite2.invitationId,
      revokedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await expect(
      acceptInvitation({
        token: invite2.token,
        password: "must(sup3rsecret)",
      }),
    ).rejects.toMatchObject({ code: "invitation_invalid" });
    expect((await lastAuditAction("team.invitation_revoked"))?.id).toBeTruthy();
  });
});

describe("role and scope management", () => {
  it("changes roles and scopes, with every change audited", async () => {
    const email = uniqueEmail("promote");
    const membership = await createMember(email, "viewer");

    await updateMember({
      memberId: membership.memberId,
      role: "developer",
      updatedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await updateMember({
      memberId: membership.memberId,
      applicationScope: "all",
      updatedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    expect(await findMembershipByEmail(email)).toMatchObject({
      role: "developer",
      applicationScope: "all",
    });

    const audited = await db
      .select()
      .from(operatorAuditLog)
      .where(eq(operatorAuditLog.action, "team.member_updated"))
      .orderBy(operatorAuditLog.createdAt);
    expect(audited).toHaveLength(2);
    expect(audited[0].metadata).toMatchObject({
      role: "developer",
      previousRole: "viewer",
    });
    expect(audited[1].metadata).toMatchObject({
      applicationScope: "all",
      previousScope: "all",
    });
  });

  it("fails closed: admins cannot manage owner members or grant owner", async () => {
    const adminEmail = uniqueEmail("admin");
    const admin = await createMember(adminEmail, "admin");
    const owner = await createMember(uniqueEmail("second-owner"), "owner");

    const asAdmin = {
      operatorId: admin.operatorId,
      role: "admin" as const,
      label: "A",
    };
    const ownerMember = await findMembershipByEmail(owner.operatorEmail);

    await expect(
      updateMember({
        memberId: must(ownerMember).memberId,
        role: "developer",
        updatedBy: asAdmin,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await expect(
      updateMember({
        memberId: admin.memberId,
        role: "owner",
        updatedBy: asAdmin,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await expect(
      removeMember({
        memberId: must(ownerMember).memberId,
        removedBy: asAdmin,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await expect(
      inviteMember({
        email: uniqueEmail("owner-invite"),
        role: "owner",
        applicationScope: "all",
        invitedBy: asAdmin,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("protects the last owner from demotion and removal", async () => {
    const email = uniqueEmail("last-owner");
    await createMember(email, "viewer");
    const owner = await findMembershipByEmail(email);

    // Bootstrap a real owner for this test via the invitation path (owner
    // actor is synthetic here — service rules only check roles).
    await updateMember({
      memberId: must(owner).memberId,
      role: "owner",
      updatedBy: {
        operatorId: must(owner).operatorId,
        role: "owner",
        label: "Self",
      },
    });

    await expect(
      updateMember({
        memberId: must(owner).memberId,
        role: "admin",
        updatedBy: {
          operatorId: must(owner).operatorId,
          role: "owner",
          label: "Self",
        },
      }),
    ).rejects.toMatchObject({ code: "last_owner" });

    await expect(
      removeMember({
        memberId: must(owner).memberId,
        removedBy: {
          operatorId: must(owner).operatorId,
          role: "owner",
          label: "Self",
        },
      }),
    ).rejects.toMatchObject({ code: "last_owner" });
  });

  it("requires at least one application for restricted scope and valid ids", async () => {
    const membership = await createMember(uniqueEmail("scope"), "developer");

    await expect(
      updateMember({
        memberId: membership.memberId,
        applicationScope: "restricted",
        applicationIds: [],
        updatedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
      }),
    ).rejects.toMatchObject({ code: "invalid_application" });

    await expect(
      updateMember({
        memberId: membership.memberId,
        applicationScope: "restricted",
        applicationIds: ["app_does_not_exist"],
        updatedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
      }),
    ).rejects.toMatchObject({ code: "invalid_application" });
  });

  it("removes members: access revoked immediately, operator kept for audit history", async () => {
    const email = uniqueEmail("leaver");
    const membership = await createMember(email, "support");

    await removeMember({
      memberId: membership.memberId,
      removedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });

    expect(await findMembershipByEmail(email)).toBeNull();
    const [operatorRow] = await db
      .select({ status: operators.status })
      .from(operators)
      .where(eq(operators.email, email));
    expect(operatorRow.status).toBe("disabled");

    const audited = await lastAuditAction("team.member_removed");
    expect(audited?.metadata).toMatchObject({ email, role: "support" });

    expect(await listTeamOverview()).toBeDefined();
  });
});

describe("admin guard: database-backed, fail-closed authorization", () => {
  it("rejects requests with no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect(guardStatus(await requireAdmin())).toBe(401);
    expect(guardStatus(await requirePermission("billing:write"))).toBe(401);
  });

  it("rejects sessions without a workspace membership (deleted row, unknown identity)", async () => {
    sessionFor("op_never_existed");
    expect(guardStatus(await requireAdmin())).toBe(401);
  });

  it("denies mutations outside the role's permissions even when the JWT claims admin", async () => {
    const membership = await createMember(uniqueEmail("support"), "support");
    // Session token still says "owner" (stale role) — the database wins.
    sessionFor(membership.operatorId);

    const allowed = await requirePermission("credits:write");
    expect(allowed).not.toBeInstanceOf(NextResponse);
    expect(allowed).toMatchObject({
      operatorId: membership.operatorId,
      role: "support",
    });

    for (const denied of [
      "billing:write",
      "providers:write",
      "credentials:write",
      "team:manage",
      "catalog:write",
      "applications:write",
      "webhooks:write",
    ] as const) {
      expect(guardStatus(await requirePermission(denied))).toBe(403);
    }
  });

  it("immediately revokes access after membership removal (no stale-token window)", async () => {
    const email = uniqueEmail("revoked");
    const membership = await createMember(email, "admin");
    sessionFor(membership.operatorId);
    expect(await requireAdmin()).not.toBeInstanceOf(NextResponse);

    await removeMember({
      memberId: membership.memberId,
      removedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });

    expect(guardStatus(await requireAdmin())).toBe(401);
    expect(guardStatus(await requirePermission("credits:write"))).toBe(401);
  });

  it("enforces restricted application scope across projects", async () => {
    const appA = await createApplication({
      slug: `scope-a-${Math.random().toString(36).slice(2, 8)}`,
      name: "Scope A",
    });
    const appB = await createApplication({
      slug: `scope-b-${Math.random().toString(36).slice(2, 8)}`,
      name: "Scope B",
    });

    const email = uniqueEmail("scoped");
    const { token } = await inviteMember({
      email,
      role: "developer",
      applicationScope: "restricted",
      applicationIds: [appA.id],
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await acceptInvitation({ token, password: "must(sup3rsecret)" });
    const membership = await findMembershipByEmail(email);
    sessionFor(must(membership).operatorId);

    const actor = await requirePermission("catalog:write");
    expect(actor).not.toBeInstanceOf(NextResponse);

    // In-scope application passes; sibling application fails closed.
    expect(requireApplicationAccess(actor as never, appA.id)).toBeNull();
    expect(guardStatus(requireApplicationAccess(actor as never, appB.id))).toBe(
      403,
    );
    expect(guardStatus(requireApplicationAccess(actor as never, ""))).toBe(403);
  });

  it("never restricts owner/admin scope", async () => {
    const app = await createApplication({
      slug: `owner-scope-${Math.random().toString(36).slice(2, 8)}`,
      name: "Owner Scope",
    });
    const membership = await createMember(uniqueEmail("admin2"), "admin");
    sessionFor(membership.operatorId);
    const actor = await requireAdmin();
    expect(requireApplicationAccess(actor as never, app.id)).toBeNull();
  });
});

describe("team service input hardening", () => {
  it("rejects malformed emails and unknown members", async () => {
    await expect(
      inviteMember({
        email: "not-an-email",
        role: "viewer",
        applicationScope: "all",
        invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
      }),
    ).rejects.toBeInstanceOf(TeamServiceError);

    await expect(
      updateMember({
        memberId: "mbr_missing",
        role: "viewer",
        updatedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      removeMember({
        memberId: "mbr_missing",
        removedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
