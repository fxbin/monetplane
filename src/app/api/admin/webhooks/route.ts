import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import {
  createWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
} from "@/modules/webhooks";
import { getConsoleContext } from "@/server/control-plane/context";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const context = await getConsoleContext();
  const application = context.selectedApplication;
  if (!application) {
    return NextResponse.json({ endpoints: [], deliveries: [], application: null });
  }
  const [endpoints, deliveries] = await Promise.all([
    listWebhookEndpoints(application.id, context.environment),
    listWebhookDeliveries(application.id, context.environment, { limit: 50 }),
  ]);
  return NextResponse.json({
    endpoints,
    deliveries,
    application,
    environment: context.environment,
  });
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const application = context.selectedApplication;
    if (!application) {
      return NextResponse.json(
        { error: "Create or select a project before adding a webhook" },
        { status: 400 },
      );
    }
    const body = (await request.json()) as {
      name?: unknown;
      url?: unknown;
      eventTypes?: unknown;
    };
    const endpoint = await createWebhookEndpoint(
      application.id,
      context.environment,
      {
        name: typeof body.name === "string" ? body.name : "",
        url: typeof body.url === "string" ? body.url : "",
        eventTypes: Array.isArray(body.eventTypes)
          ? body.eventTypes.filter((value): value is string => typeof value === "string")
          : undefined,
      },
    );
    return NextResponse.json(
      {
        endpoint,
        notice:
          "The signing secret is shown once. Store it with the receiving service and verify x-monetplane-signature on every delivery.",
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create webhook";
    const status = /unique|duplicate/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
