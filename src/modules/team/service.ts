import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications } from "@/modules/applications/schema";
import {
  hashPassword,
  secretsMatch,
  verifyPassword,
} from "@/modules/team/password";
import type {
  MemberApplicationScope,
  WorkspaceRole,
} from "@/modules/team/permissions";
import {
  memberApplicationAccess,
  operatorInvitations,
  operators,
  workspaceMembers,
} from "@/modules/team/schema";

/**
 * Team service (#70) — invitation, membership, and operator lifecycle.
 *
 * Owner-exclusive invariants (protecting owner members, granting the owner
 * role) are enforced here, not only in the console UI, so an admin calling
 * the admin APIs directly still fails closed.
 */

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class TeamServiceError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "TeamServiceError";
    this.status = status;
    this.code = code;
  }
}

export type TeamActor = {
  operatorId: string;
  role: WorkspaceRole;
  label?: string | null;
};

export type MembershipRecord = {
  operatorId: string;
  operatorEmail: string;
  operatorName: string;
  operatorStatus: "active" | "disabled";
  memberId: string;
  role: WorkspaceRole;
  applicationScope: MemberApplicationScope;
  applicationIds: string[];
  lastLoginAt: Date | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findMembershipByEmail(
  email: string,
): Promise<MembershipRecord | null> {
  return findMembership(operators.email, normalizeEmail(email));
}

export async function findMembershipByOperatorId(
  operatorId: string,
): Promise<MembershipRecord | null> {
  return findMembership(operators.id, operatorId);
}

async function findMembership(
  column: typeof operators.email | typeof operators.id,
  value: string,
): Promise<MembershipRecord | null> {
  const db = getDb();
  const [row] = await db
    .select({
      operatorId: operators.id,
      operatorEmail: operators.email,
      operatorName: operators.name,
      operatorStatus: operators.status,
      lastLoginAt: operators.lastLoginAt,
      memberId: workspaceMembers.id,
      role: workspaceMembers.role,
      applicationScope: workspaceMembers.applicationScope,
    })
    .from(workspaceMembers)
    .innerJoin(operators, eq(workspaceMembers.operatorId, operators.id))
    .where(eq(column, value))
    .limit(1);

  if (!row) return null;

  const applicationIds =
    row.applicationScope === "restricted"
      ? (
          await db
            .select({ applicationId: memberApplicationAccess.applicationId })
            .from(memberApplicationAccess)
            .where(eq(memberApplicationAccess.memberId, row.memberId))
        ).map((access) => access.applicationId)
      : [];

  return {
    operatorId: row.operatorId,
    operatorEmail: row.operatorEmail,
    operatorName: row.operatorName,
    operatorStatus: row.operatorStatus as MembershipRecord["operatorStatus"],
    memberId: row.memberId,
    role: row.role as WorkspaceRole,
    applicationScope: row.applicationScope as MemberApplicationScope,
    applicationIds,
    lastLoginAt: row.lastLoginAt,
  };
}

async function countOperators(): Promise<number> {
  const rows = await getDb()
    .select({ id: operators.id })
    .from(operators)
    .limit(1);
  return rows.length;
}

/**
 * Credential check for console sign-in. When the installation has no
 * operators yet, the ADMIN_PASSWORD holder may claim the first owner account
 * (bootstrap-on-first-login); afterwards the shared password is inert.
 */
export async function authenticateWithBootstrap(input: {
  email: string;
  password: string;
}): Promise<{
  operatorId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
} | null> {
  const email = normalizeEmail(input.email);
  const password = input.password;

  const membership = await findMembershipByEmail(email);
  if (membership) {
    if (membership.operatorStatus !== "active") return null;
    const ok = await verifyPassword(
      password,
      await getPasswordHash(membership.operatorId),
    );
    if (!ok) return null;
    await getDb()
      .update(operators)
      .set({ lastLoginAt: new Date() })
      .where(eq(operators.id, membership.operatorId));
    return {
      operatorId: membership.operatorId,
      email: membership.operatorEmail,
      name: membership.operatorName,
      role: membership.role,
    };
  }

  if ((await countOperators()) > 0) return null;

  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  if (!adminPassword || !secretsMatch(password, adminPassword)) return null;

  const operatorId = `op_${randomUUID()}`;
  const memberId = `mbr_${randomUUID()}`;
  const name = email.split("@")[0] || "Owner";
  await getDb().transaction(async (tx) => {
    await tx.insert(operators).values({
      id: operatorId,
      email,
      name,
      passwordHash: await hashPassword(password),
      status: "active",
    });
    await tx.insert(workspaceMembers).values({
      id: memberId,
      operatorId,
      role: "owner",
      applicationScope: "all",
    });
  });

  const { recordAuditEntry } = await import("@/server/control-plane/audit");
  await recordAuditEntry({
    applicationId: null,
    action: "team.owner_bootstrapped",
    resourceType: "operator",
    resourceId: operatorId,
    metadata: { email },
    actor: { id: operatorId, label: name },
  });

  return { operatorId, email, name, role: "owner" };
}

async function getPasswordHash(operatorId: string): Promise<string> {
  const [row] = await getDb()
    .select({ passwordHash: operators.passwordHash })
    .from(operators)
    .where(eq(operators.id, operatorId))
    .limit(1);
  if (!row) return "scrypt$0$0$0$00$00";
  return row.passwordHash;
}

export type TeamMemberView = MembershipRecord & { createdAt: Date };

export type TeamInvitationView = {
  id: string;
  email: string;
  role: WorkspaceRole;
  applicationScope: MemberApplicationScope;
  applicationIds: string[];
  status: string;
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
};

export async function listTeamOverview(): Promise<{
  members: TeamMemberView[];
  invitations: TeamInvitationView[];
}> {
  const db = getDb();
  const memberRows = await db
    .select({
      operatorId: operators.id,
      operatorEmail: operators.email,
      operatorName: operators.name,
      operatorStatus: operators.status,
      lastLoginAt: operators.lastLoginAt,
      memberId: workspaceMembers.id,
      role: workspaceMembers.role,
      applicationScope: workspaceMembers.applicationScope,
      createdAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(operators, eq(workspaceMembers.operatorId, operators.id))
    .orderBy(asc(workspaceMembers.createdAt));

  const accessRows = await db
    .select({
      memberId: memberApplicationAccess.memberId,
      applicationId: memberApplicationAccess.applicationId,
    })
    .from(memberApplicationAccess);
  const accessByMember = new Map<string, string[]>();
  for (const access of accessRows) {
    const list = accessByMember.get(access.memberId) ?? [];
    list.push(access.applicationId);
    accessByMember.set(access.memberId, list);
  }

  const members: TeamMemberView[] = memberRows.map((row) => ({
    operatorId: row.operatorId,
    operatorEmail: row.operatorEmail,
    operatorName: row.operatorName,
    operatorStatus: row.operatorStatus as MembershipRecord["operatorStatus"],
    memberId: row.memberId,
    role: row.role as WorkspaceRole,
    applicationScope: row.applicationScope as MemberApplicationScope,
    applicationIds: accessByMember.get(row.memberId) ?? [],
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  }));

  const invitations: TeamInvitationView[] = (
    await db
      .select()
      .from(operatorInvitations)
      .where(eq(operatorInvitations.status, "pending"))
      .orderBy(asc(operatorInvitations.createdAt))
  ).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role as WorkspaceRole,
    applicationScope: row.applicationScope as MemberApplicationScope,
    applicationIds: [],
    status: row.status,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));

  return { members, invitations };
}

async function assertCanManageTarget(
  actor: TeamActor,
  targetRole: WorkspaceRole,
) {
  if (targetRole === "owner" && actor.role !== "owner") {
    throw new TeamServiceError(
      "Only the workspace owner can manage owner members",
      403,
      "forbidden",
    );
  }
}

async function countOtherOwners(exceptMemberId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.role, "owner"),
        ne(workspaceMembers.id, exceptMemberId),
      ),
    )
    .limit(1);
  return rows.length;
}

async function validateApplicationIds(applicationIds: string[]) {
  if (applicationIds.length === 0) return;
  const rows = await getDb()
    .select({ id: applications.id })
    .from(applications)
    .where(inArray(applications.id, applicationIds));
  if (rows.length !== new Set(applicationIds).size) {
    throw new TeamServiceError(
      "One or more applications do not exist",
      400,
      "invalid_application",
    );
  }
}

export async function inviteMember(input: {
  email: string;
  role: WorkspaceRole;
  applicationScope: MemberApplicationScope;
  applicationIds?: string[];
  invitedBy: TeamActor;
}): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  if (input.invitedBy.role !== "owner" && input.invitedBy.role !== "admin") {
    throw new TeamServiceError(
      "Not permitted to invite members",
      403,
      "forbidden",
    );
  }
  if (input.role === "owner" && input.invitedBy.role !== "owner") {
    throw new TeamServiceError(
      "Only the workspace owner can grant the owner role",
      403,
      "forbidden",
    );
  }
  if (
    input.applicationScope === "restricted" &&
    !input.applicationIds?.length
  ) {
    throw new TeamServiceError(
      "Restricted scope requires at least one application",
      400,
      "invalid_application",
    );
  }
  await validateApplicationIds(input.applicationIds ?? []);

  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TeamServiceError(
      "A valid email is required",
      400,
      "invalid_email",
    );
  }

  const db = getDb();
  const existingMembership = await findMembershipByEmail(email);
  if (existingMembership && existingMembership.operatorStatus === "active") {
    throw new TeamServiceError(
      "This email is already a workspace member",
      409,
      "already_member",
    );
  }
  const [pending] = await db
    .select({ id: operatorInvitations.id })
    .from(operatorInvitations)
    .where(
      and(
        eq(operatorInvitations.email, email),
        eq(operatorInvitations.status, "pending"),
        gt(operatorInvitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (pending) {
    throw new TeamServiceError(
      "A pending invitation already exists for this email",
      409,
      "invitation_pending",
    );
  }

  const token = randomBytes(32).toString("base64url");
  const invitationId = `inv_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  await db.insert(operatorInvitations).values({
    id: invitationId,
    email,
    role: input.role,
    applicationScope: input.applicationScope,
    applicationIds:
      input.applicationScope === "restricted"
        ? [...new Set(input.applicationIds ?? [])]
        : [],
    tokenHash: hashToken(token),
    status: "pending",
    invitedBy: input.invitedBy.operatorId,
    expiresAt,
  });

  const { recordAuditEntry } = await import("@/server/control-plane/audit");
  await recordAuditEntry({
    applicationId: null,
    action: "team.invitation_created",
    resourceType: "operator_invitation",
    resourceId: invitationId,
    metadata: {
      email,
      role: input.role,
      applicationScope: input.applicationScope,
      applicationIds: input.applicationIds ?? [],
    },
    actor: { id: input.invitedBy.operatorId, label: input.invitedBy.label },
  });

  return { invitationId, token, expiresAt };
}

export async function acceptInvitation(input: {
  token: string;
  name?: string;
  password: string;
}): Promise<{ email: string }> {
  const password = input.password;
  if (typeof password !== "string" || password.length < 8) {
    throw new TeamServiceError(
      "Password must be at least 8 characters",
      400,
      "invalid_password",
    );
  }

  const db = getDb();
  const [invitation] = await db
    .select()
    .from(operatorInvitations)
    .where(eq(operatorInvitations.tokenHash, hashToken(input.token)))
    .limit(1);

  if (
    !invitation ||
    invitation.status !== "pending" ||
    invitation.expiresAt.getTime() <= Date.now()
  ) {
    throw new TeamServiceError(
      "This invitation is no longer valid",
      410,
      "invitation_invalid",
    );
  }

  const operatorId = `op_${randomUUID()}`;
  const memberId = `mbr_${randomUUID()}`;
  const name =
    (typeof input.name === "string" && input.name.trim()) ||
    invitation.email.split("@")[0] ||
    "Operator";
  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: operators.id })
      .from(operators)
      .where(eq(operators.email, invitation.email))
      .limit(1);

    let resolvedOperatorId = operatorId;
    if (existing) {
      // Re-invitation of a previously removed member: restore identity.
      resolvedOperatorId = existing.id;
      await tx
        .update(operators)
        .set({ name, passwordHash, status: "active", updatedAt: new Date() })
        .where(eq(operators.id, existing.id));
    } else {
      await tx.insert(operators).values({
        id: operatorId,
        email: invitation.email,
        name,
        passwordHash,
        status: "active",
      });
    }

    await tx
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.operatorId, resolvedOperatorId));
    await tx.insert(workspaceMembers).values({
      id: memberId,
      operatorId: resolvedOperatorId,
      role: invitation.role,
      applicationScope: invitation.applicationScope,
    });
    if (invitation.applicationScope === "restricted") {
      await tx.insert(memberApplicationAccess).values(
        invitation.applicationIds.map((applicationId) => ({
          memberId,
          applicationId,
        })),
      );
    }

    await tx
      .update(operatorInvitations)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(operatorInvitations.id, invitation.id));
  });

  const { recordAuditEntry } = await import("@/server/control-plane/audit");
  await recordAuditEntry({
    applicationId: null,
    action: "team.member_joined",
    resourceType: "workspace_member",
    resourceId: memberId,
    metadata: {
      email: invitation.email,
      role: invitation.role,
      invitationId: invitation.id,
    },
    actor: { id: memberId, label: name },
  });

  return { email: invitation.email };
}

export async function revokeInvitation(input: {
  invitationId: string;
  revokedBy: TeamActor;
}): Promise<void> {
  if (input.revokedBy.role !== "owner" && input.revokedBy.role !== "admin") {
    throw new TeamServiceError(
      "Not permitted to revoke invitations",
      403,
      "forbidden",
    );
  }
  const db = getDb();
  const [invitation] = await db
    .select()
    .from(operatorInvitations)
    .where(eq(operatorInvitations.id, input.invitationId))
    .limit(1);
  if (!invitation) {
    throw new TeamServiceError("Invitation not found", 404, "not_found");
  }
  await db
    .update(operatorInvitations)
    .set({ status: "revoked" })
    .where(eq(operatorInvitations.id, input.invitationId));

  const { recordAuditEntry } = await import("@/server/control-plane/audit");
  await recordAuditEntry({
    applicationId: null,
    action: "team.invitation_revoked",
    resourceType: "operator_invitation",
    resourceId: input.invitationId,
    metadata: { email: invitation.email },
    actor: { id: input.revokedBy.operatorId, label: input.revokedBy.label },
  });
}

export async function updateMember(input: {
  memberId: string;
  role?: WorkspaceRole;
  applicationScope?: MemberApplicationScope;
  applicationIds?: string[];
  updatedBy: TeamActor;
}): Promise<void> {
  const db = getDb();
  const [target] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, input.memberId))
    .limit(1);
  if (!target) {
    throw new TeamServiceError("Member not found", 404, "not_found");
  }
  await assertCanManageTarget(input.updatedBy, target.role as WorkspaceRole);

  if (input.role && input.role !== target.role) {
    if (input.role === "owner" && input.updatedBy.role !== "owner") {
      throw new TeamServiceError(
        "Only the workspace owner can grant the owner role",
        403,
        "forbidden",
      );
    }
    if (target.role === "owner" && (await countOtherOwners(target.id)) === 0) {
      throw new TeamServiceError(
        "At least one owner must remain",
        409,
        "last_owner",
      );
    }
  }

  const scope =
    input.applicationScope ??
    (target.applicationScope as MemberApplicationScope);
  const applicationIds =
    input.applicationIds ??
    (scope === "restricted"
      ? (
          await db
            .select({ applicationId: memberApplicationAccess.applicationId })
            .from(memberApplicationAccess)
            .where(eq(memberApplicationAccess.memberId, target.id))
        ).map((row) => row.applicationId)
      : []);

  if (scope === "restricted" && applicationIds.length === 0) {
    throw new TeamServiceError(
      "Restricted scope requires at least one application",
      400,
      "invalid_application",
    );
  }
  await validateApplicationIds(applicationIds);

  await db.transaction(async (tx) => {
    await tx
      .update(workspaceMembers)
      .set({
        role: input.role ?? target.role,
        applicationScope: scope,
        updatedAt: new Date(),
      })
      .where(eq(workspaceMembers.id, target.id));

    if (input.applicationScope || input.applicationIds) {
      await tx
        .delete(memberApplicationAccess)
        .where(eq(memberApplicationAccess.memberId, target.id));
      if (scope === "restricted") {
        await tx.insert(memberApplicationAccess).values(
          [...new Set(applicationIds)].map((applicationId) => ({
            memberId: target.id,
            applicationId,
          })),
        );
      }
    }
  });

  const { recordAuditEntry } = await import("@/server/control-plane/audit");
  await recordAuditEntry({
    applicationId: null,
    action: "team.member_updated",
    resourceType: "workspace_member",
    resourceId: target.id,
    metadata: {
      role: input.role ?? target.role,
      applicationScope: scope,
      applicationIds,
      previousRole: target.role,
      previousScope: target.applicationScope,
    },
    actor: { id: input.updatedBy.operatorId, label: input.updatedBy.label },
  });
}

export async function removeMember(input: {
  memberId: string;
  removedBy: TeamActor;
}): Promise<void> {
  const db = getDb();
  const [target] = await db
    .select({
      memberId: workspaceMembers.id,
      role: workspaceMembers.role,
      operatorId: workspaceMembers.operatorId,
      operatorEmail: operators.email,
      operatorName: operators.name,
    })
    .from(workspaceMembers)
    .innerJoin(operators, eq(workspaceMembers.operatorId, operators.id))
    .where(eq(workspaceMembers.id, input.memberId))
    .limit(1);
  if (!target) {
    throw new TeamServiceError("Member not found", 404, "not_found");
  }
  await assertCanManageTarget(input.removedBy, target.role as WorkspaceRole);
  if (
    target.role === "owner" &&
    (await countOtherOwners(target.memberId)) === 0
  ) {
    throw new TeamServiceError(
      "At least one owner must remain",
      409,
      "last_owner",
    );
  }

  await db.transaction(async (tx) => {
    // Keep the operator row (audit history references it) but revoke access.
    await tx
      .update(operators)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(eq(operators.id, target.operatorId));
    await tx
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, target.memberId));
  });

  const { recordAuditEntry } = await import("@/server/control-plane/audit");
  await recordAuditEntry({
    applicationId: null,
    action: "team.member_removed",
    resourceType: "workspace_member",
    resourceId: target.memberId,
    metadata: { email: target.operatorEmail, role: target.role },
    actor: { id: input.removedBy.operatorId, label: input.removedBy.label },
  });
}
