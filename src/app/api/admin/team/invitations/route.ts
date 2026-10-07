import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import { requirePermission } from "@/modules/admin/guard";
import {
  isMemberApplicationScope,
  isWorkspaceRole,
} from "@/modules/team/permissions";
import { inviteMember, TeamServiceError } from "@/modules/team/service";

/**
 * POST /api/admin/team/invitations — invite a new operator (team:manage).
 * The invitation URL is returned once; only its hash is stored.
 */
export async function POST(request: Request) {
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requirePermission("team:manage");
  if (guard instanceof NextResponse) return guard;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email : "";
    const role = body.role;
    const applicationScope = body.applicationScope ?? "all";
    const applicationIds = Array.isArray(body.applicationIds)
      ? body.applicationIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];

    if (!isWorkspaceRole(role)) {
      return NextResponse.json(
        { error: adminErrors.chooseAValidRole },
        { status: 400 },
      );
    }
    if (!isMemberApplicationScope(applicationScope)) {
      return NextResponse.json(
        { error: adminErrors.invalidApplicationScope },
        { status: 400 },
      );
    }

    const invitation = await inviteMember({
      email,
      role,
      applicationScope,
      applicationIds,
      invitedBy: {
        operatorId: guard.operatorId,
        role: guard.role,
        label: guard.name,
      },
    });

    const origin = new URL(request.url).origin;
    return NextResponse.json(
      {
        invitationId: invitation.invitationId,
        expiresAt: invitation.expiresAt,
        inviteUrl: `${origin}/invitations/accept?token=${invitation.token}`,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof TeamServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("[admin/team/invitations] Error:", error);
    return NextResponse.json(
      { error: adminErrors.failedToCreateInvitation },
      { status: 500 },
    );
  }
}
