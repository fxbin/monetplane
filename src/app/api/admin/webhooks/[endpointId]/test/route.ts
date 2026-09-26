import { NextResponse } from "next/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { createTestWebhookDelivery } from "@/modules/webhooks";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = { params: Promise<{ endpointId: string }> };

export async function POST(_request: Request, { params }: RouteContext) {
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
    const delivery = await createTestWebhookDelivery(
      application.id,
      context.environment,
      endpointId,
    );
    await recordAuditEntry({
      applicationId: application.id,
      environment: context.environment,
      action: "webhook_endpoint.tested",
      resourceType: "webhook_endpoint",
      resourceId: endpointId,
      metadata: { deliveryId: delivery.id, status: delivery.status },
      request: _request,
    });
    return NextResponse.json({ delivery });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to test webhook";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
