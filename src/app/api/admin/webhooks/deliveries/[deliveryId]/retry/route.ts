import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { retryWebhookDelivery } from "@/modules/webhooks";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = { params: Promise<{ deliveryId: string }> };

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [context, { deliveryId }] = await Promise.all([
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
    const delivery = await retryWebhookDelivery(
      application.id,
      context.environment,
      deliveryId,
    );
    await recordAuditEntry({
      applicationId: application.id,
      environment: context.environment,
      action: "webhook_delivery.retried",
      resourceType: "webhook_delivery",
      resourceId: deliveryId,
      metadata: { status: delivery.status },
      request: _request,
    });
    return NextResponse.json({ delivery });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to retry webhook";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
