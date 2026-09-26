import { NextResponse } from "next/server";
import { requirePermission } from "@/modules/admin/guard";
import { revokeInvitation, TeamServiceError } from "@/modules/team/service";

type RouteContext = {
  params: Promise<{ invitationId: string }>;
};

/** DELETE /api/admin/team/invitations/[invitationId] — revoke a pending invitation. */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const guard = await requirePermission("team:manage");
  if (guard instanceof NextResponse) return guard;

  try {
    const { invitationId } = await params;
    await revokeInvitation({
      invitationId,
      revokedBy: {
        operatorId: guard.operatorId,
        role: guard.role,
        label: guard.name,
      },
    });
    return NextResponse.json({ revoked: true });
  } catch (error) {
    if (error instanceof TeamServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("[admin/team/invitations] Delete error:", error);
    return NextResponse.json(
      { error: "Failed to revoke invitation" },
      { status: 500 },
    );
  }
}
