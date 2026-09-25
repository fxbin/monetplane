import { NextResponse } from "next/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { disableWebhookEndpoint } from "@/modules/webhooks";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = { params: Promise<{ endpointId: string }> };

export async function DELETE(_request: Request, { params }: RouteContext) {
  const guard = await requirePermission("webhooks:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const [context, { endpointId }] = await Promise.all([
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
    const endpoint = await disableWebhookEndpoint(
      application.id,
      context.environment,
      endpointId,
    );
    await recordAuditEntry({
      applicationId: application.id,
      environment: context.environment,
      action: "webhook_endpoint.disabled",
      resourceType: "webhook_endpoint",
      resourceId: endpoint.id,
      request: _request,
    });
    return NextResponse.json({ endpoint });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to disable webhook";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
