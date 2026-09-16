import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { disableWebhookEndpoint } from "@/modules/webhooks";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = { params: Promise<{ endpointId: string }> };

export async function DELETE(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
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
    const endpoint = await disableWebhookEndpoint(
      application.id,
      context.environment,
      endpointId,
    );
    return NextResponse.json({ endpoint });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to disable webhook";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
