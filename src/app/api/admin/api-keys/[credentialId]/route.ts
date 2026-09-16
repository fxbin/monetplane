import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getConsoleContext } from "@/server/control-plane/context";
import { revokeDeveloperApiKey } from "@/server/control-plane/developer";

type RouteContext = { params: Promise<{ credentialId: string }> };

export async function DELETE(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [context, { credentialId }] = await Promise.all([
      getConsoleContext(),
      params,
    ]);
    const application = context.selectedApplication;
    if (!application) {
      return NextResponse.json({ error: "No project selected" }, { status: 400 });
    }
    const result = await revokeDeveloperApiKey(application.id, credentialId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to revoke API key";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
