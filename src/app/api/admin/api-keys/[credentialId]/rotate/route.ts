import { NextResponse } from "next/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { getConsoleContext } from "@/server/control-plane/context";
import { rotateDeveloperApiKey } from "@/server/control-plane/developer";

type RouteContext = { params: Promise<{ credentialId: string }> };

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requirePermission("credentials:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const [context, { credentialId }] = await Promise.all([
      getConsoleContext(),
      params,
    ]);
    const application = context.selectedApplication;
    if (!application) {
      return NextResponse.json(
        { error: "No project selected" },
        { status: 400 },
      );
    }

    const scopeCheck = requireApplicationAccess(guard, application.id);
    if (scopeCheck) return scopeCheck;
    const key = await rotateDeveloperApiKey(application.id, credentialId);
    await recordAuditEntry({
      applicationId: application.id,
      action: "api_key.rotated",
      resourceType: "application_credential",
      resourceId: key.id,
      metadata: { secretPrefix: key.secretPrefix },
      request: _request,
    });
    return NextResponse.json({
      key,
      notice:
        "The replacement secret is shown once. The previous key remains active until you explicitly revoke it after deployment.",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to rotate API key";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
