import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getConsoleContext } from "@/server/control-plane/context";
import { rotateDeveloperApiKey } from "@/server/control-plane/developer";

type RouteContext = { params: Promise<{ credentialId: string }> };

export async function POST(_request: Request, { params }: RouteContext) {
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
    const key = await rotateDeveloperApiKey(application.id, credentialId);
    return NextResponse.json({
      key,
      notice:
        "The replacement secret is shown once. The previous key remains active until you explicitly revoke it after deployment.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to rotate API key";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
