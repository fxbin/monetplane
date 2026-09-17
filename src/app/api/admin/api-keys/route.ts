import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { getConsoleContext } from "@/server/control-plane/context";
import {
  createDeveloperApiKey,
  listDeveloperApiKeys,
} from "@/server/control-plane/developer";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const context = await getConsoleContext();
  const application = context.selectedApplication;
  if (!application) {
    return NextResponse.json({ keys: [], application: null });
  }
  const keys = await listDeveloperApiKeys(application.id);
  return NextResponse.json({ keys, application });
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const application = context.selectedApplication;
    if (!application) {
      return NextResponse.json(
        { error: "Create or select a project before creating an API key" },
        { status: 400 },
      );
    }
    const body = (await request.json()) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { error: "API key name is required" },
        { status: 400 },
      );
    }
    const key = await createDeveloperApiKey(application.id, name);
    await recordAuditEntry({
      applicationId: application.id,
      action: "api_key.created",
      resourceType: "application_credential",
      resourceId: key.id,
      metadata: { name, secretPrefix: key.secretPrefix },
      request,
    });
    return NextResponse.json(
      {
        key,
        notice:
          "This secret is shown once. Store it in a server-side secret manager.",
      },
      { status: 201 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create API key";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
