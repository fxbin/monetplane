import { NextResponse } from "next/server";
import { requirePermission } from "@/modules/admin/guard";
import {
  isMemberApplicationScope,
  isWorkspaceRole,
} from "@/modules/team/permissions";
import {
  removeMember,
  TeamServiceError,
  updateMember,
} from "@/modules/team/service";

type RouteContext = {
  params: Promise<{ memberId: string }>;
};

/**
 * PATCH /api/admin/team/members/[memberId] — change role and/or application
 * scope of a member (team:manage). Owner rows and the owner role can only be
 * managed by an owner; enforced in the service, not the UI.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const guard = await requirePermission("team:manage");
  if (guard instanceof NextResponse) return guard;

  try {
    const { memberId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const role = body.role === undefined ? undefined : body.role;
    const applicationScope =
      body.applicationScope === undefined ? undefined : body.applicationScope;
    const applicationIds = Array.isArray(body.applicationIds)
      ? body.applicationIds.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;

    if (role !== undefined && !isWorkspaceRole(role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    if (
      applicationScope !== undefined &&
      !isMemberApplicationScope(applicationScope)
    ) {
      return NextResponse.json(
        { error: "Invalid application scope" },
        { status: 400 },
      );
    }

    await updateMember({
      memberId,
      role,
      applicationScope,
      applicationIds,
      updatedBy: {
        operatorId: guard.operatorId,
        role: guard.role,
        label: guard.name,
      },
    });
    return NextResponse.json({ updated: true });
  } catch (error) {
    if (error instanceof TeamServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("[admin/team/members] Patch error:", error);
    return NextResponse.json(
      { error: "Failed to update member" },
      { status: 500 },
    );
  }
}

/** DELETE /api/admin/team/members/[memberId] — remove a member from the workspace. */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const guard = await requirePermission("team:manage");
  if (guard instanceof NextResponse) return guard;

  try {
    const { memberId } = await params;
    await removeMember({
      memberId,
      removedBy: {
        operatorId: guard.operatorId,
        role: guard.role,
        label: guard.name,
      },
    });
    return NextResponse.json({ removed: true });
  } catch (error) {
    if (error instanceof TeamServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("[admin/team/members] Delete error:", error);
    return NextResponse.json(
      { error: "Failed to remove member" },
      { status: 500 },
    );
  }
}
