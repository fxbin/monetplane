import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import { getSessionActor } from "@/modules/admin/guard";
import {
  changeOperatorPasswordWithAudit,
  TeamServiceError,
} from "@/modules/team/service";

/**
 * Self-service password rotation for the signed-in operator (roundtable
 * 2026-10-06, PR1). Previously a leaked operator password could only be
 * remediated by re-provisioning ADMIN_PASSWORD and restarting — this closes
 * that security gap. The current password is verified before rotating; the
 * audit entry records the actor and never the credential material.
 */
export async function POST(request: Request) {
  const adminErrors = (await getDictionary()).adminErrors;
  // Workspace-level (not project-scoped) and — per the self-service
  // semantics (external review 2026-10-06, P1-150-01) — available to
  // EVERY authenticated operator: team:manage governs managing OTHER
  // accounts; rotating your own password must not require it, or a
  // leaked low-privilege credential could never be rotated by its owner.
  const actor = await getSessionActor();
  if (!actor) {
    return NextResponse.json(
      { error: adminErrors.unauthorized },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: adminErrors.invalidJsonBody },
      { status: 400 },
    );
  }

  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword =
    typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: adminErrors.currentpasswordAndNewpasswordAreRequired },
      { status: 400 },
    );
  }

  try {
    // Password + audit land in the SAME transaction (external review
    // P2-150-01): a crash between the two can no longer leave a rotated
    // password without its audit trail.
    await changeOperatorPasswordWithAudit({
      operatorId: actor.operatorId,
      currentPassword,
      newPassword,
      audit: {
        request,
        actor: { id: actor.operatorId, label: actor.email },
      },
    });
  } catch (error) {
    // Honor the service's own error classification (external review
    // P2-150-02) instead of string-matching the message; unknown
    // errors log server-side and answer a generic 500.
    if (error instanceof TeamServiceError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/session/password] Error:", error);
    return NextResponse.json(
      { error: adminErrors.failedToChangePassword },
      { status: 500 },
    );
  }

  return NextResponse.json({ changed: true });
}
