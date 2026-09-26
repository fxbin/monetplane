import { NextResponse } from "next/server";
import { requirePermission } from "@/modules/admin/guard";
import { permissionMatrix } from "@/modules/team/permissions";
import { listTeamOverview } from "@/modules/team/service";

/**
 * GET /api/admin/team — members and pending invitations.
 * Gated by team:manage: the listing exists to manage the workspace.
 */
export async function GET() {
  const guard = await requirePermission("team:manage");
  if (guard instanceof NextResponse) return guard;

  try {
    const team = await listTeamOverview();
    return NextResponse.json({
      members: team.members,
      invitations: team.invitations,
      viewer: {
        operatorId: guard.operatorId,
        role: guard.role,
      },
      permissionMatrix: permissionMatrix(),
    });
  } catch (error) {
    console.error("[admin/team] Error:", error);
    return NextResponse.json({ error: "Failed to load team" }, { status: 500 });
  }
}
