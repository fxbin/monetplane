import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  type MemberApplicationScope,
  roleHasPermission,
  type TeamPermission,
  type WorkspaceRole,
} from "@/modules/team/permissions";
import { findMembershipByOperatorId } from "@/modules/team/service";

/**
 * Admin API guard (#70) — cookie-session console authentication plus
 * database-backed role/permission authorization.
 *
 * This is separate from the SDK Bearer token auth used on /api/* routes.
 * Admin API routes live under /api/admin/*.
 *
 * Fail-closed properties:
 * - The JWT session is only an identity claim; role, membership status, and
 *   application scope are re-read from the database on every request, so role
 *   changes and removals take effect immediately (no 12h stale-token window).
 * - A session without a workspace membership row, a disabled operator, or an
 *   unknown role is rejected.
 * - Unknown permissions cannot be granted by data — callers must pass a
 *   compile-time TeamPermission.
 *
 * Usage:
 * ```ts
 * import { requirePermission } from "@/modules/admin/guard";
 *
 * export async function POST(request: Request) {
 *   const guard = await requirePermission("billing:write");
 *   if (guard instanceof NextResponse) return guard;
 *   // guard is an AdminActor: operatorId, role, applicationScope…
 * }
 * ```
 */

export type AdminActor = {
  operatorId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  applicationScope: MemberApplicationScope;
  applicationIds: string[];
  memberId: string;
};

function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized", code: "unauthorized" },
    { status: 401 },
  );
}

function forbidden(permission: TeamPermission) {
  return NextResponse.json(
    {
      error: "Forbidden: your workspace role does not permit this action",
      code: "forbidden",
      requiredPermission: permission,
    },
    { status: 403 },
  );
}

async function loadActor(): Promise<AdminActor | null> {
  const session = await auth();
  const operatorId = session?.user?.id;
  if (!operatorId || !session.user) return null;

  const membership = await findMembershipByOperatorId(operatorId);
  if (!membership) return null;
  if (membership.operatorStatus !== "active") return null;

  return {
    operatorId: membership.operatorId,
    email: membership.operatorEmail,
    name: membership.operatorName,
    role: membership.role,
    applicationScope: membership.applicationScope,
    applicationIds: membership.applicationIds,
    memberId: membership.memberId,
  };
}

/** Any active workspace member (read access across the console). */
export async function requireAdmin(): Promise<AdminActor | NextResponse> {
  const actor = await loadActor();
  if (!actor) return unauthorized();
  return actor;
}

/**
 * Session actor without failing — for server components and helpers that
 * narrow UI by role/scope (authorization itself still goes through the
 * require* guards at every API boundary).
 */
export async function getSessionActor(): Promise<AdminActor | null> {
  return loadActor();
}

/** Active member holding a specific console mutation permission. */
export async function requirePermission(
  permission: TeamPermission,
): Promise<AdminActor | NextResponse> {
  const actor = await loadActor();
  if (!actor) return unauthorized();
  if (!roleHasPermission(actor.role, permission)) return forbidden(permission);
  return actor;
}

/**
 * Application-scope enforcement for restricted members. Owners/admins always
 * pass; a restricted member must have an explicit access grant for the target
 * application. Returns null when access is allowed.
 */
export function requireApplicationAccess(
  actor: AdminActor,
  applicationId: string,
): NextResponse | null {
  if (actor.applicationScope === "all") return null;
  if (!applicationId) {
    return NextResponse.json(
      { error: "No accessible application selected", code: "forbidden" },
      { status: 403 },
    );
  }
  if (!actor.applicationIds.includes(applicationId)) {
    return NextResponse.json(
      {
        error: "Forbidden: this project is outside your workspace access scope",
        code: "forbidden",
      },
      { status: 403 },
    );
  }
  return null;
}
