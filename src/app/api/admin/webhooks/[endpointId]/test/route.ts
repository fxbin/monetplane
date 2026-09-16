import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { createTestWebhookDelivery } from "@/modules/webhooks";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = { params: Promise<{ endpointId: string }> };

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [context, { endpointId }] = await Promise.all([
      getConsoleContext(),
      params,
    ]);
    const application = context.selectedApplication;
    if (!application) {
      return NextResponse.json({ error: "No project selected" }, { status: 400 });
    }
    const delivery = await createTestWebhookDelivery(
      application.id,
      context.environment,
      endpointId,
    );
    return NextResponse.json({ delivery });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to test webhook";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
