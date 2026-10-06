import { NextResponse } from "next/server";
import { requirePermission } from "@/modules/admin/guard";
import { changeOperatorPassword } from "@/modules/team/service";
import { recordAuditEntry } from "@/server/control-plane/audit";

/**
 * Self-service password rotation for the signed-in operator (roundtable
 * 2026-10-06, PR1). Previously a leaked operator password could only be
 * remediated by re-provisioning ADMIN_PASSWORD and restarting — this closes
 * that security gap. The current password is verified before rotating; the
 * audit entry records the actor and never the credential material.
 */
export async function POST(request: Request) {
  // Workspace-level (not project-scoped): guard directly instead of
  // adminAction, which requires a selected application.
  const guard = await requirePermission("team:manage");
  if (guard instanceof NextResponse) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword =
    typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: "currentPassword and newPassword are required" },
      { status: 400 },
    );
  }

  try {
    await changeOperatorPassword({
      operatorId: guard.operatorId,
      currentPassword,
      newPassword,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to change password";
    const status = message.includes("incorrect") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  await recordAuditEntry({
    applicationId: null,
    action: "operator.password_changed",
    resourceType: "operator",
    resourceId: guard.operatorId,
    metadata: { selfService: true },
    request,
    actor: { id: guard.operatorId, label: guard.name || guard.email },
  });

  return NextResponse.json({ changed: true });
}
