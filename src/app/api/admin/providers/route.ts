import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getProviderList } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const providers = await getProviderList(
      context.selectedApplication?.id,
      context.environment,
    );
    return NextResponse.json({
      context: {
        application: context.selectedApplication,
        environment: context.environment,
      },
      providers,
    });
  } catch (error) {
    console.error("[admin/providers] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch providers" },
      { status: 500 },
    );
  }
}
