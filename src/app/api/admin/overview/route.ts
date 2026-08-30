import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getOverviewStats, getRecentOrders } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const applicationId = context.selectedApplication?.id;
    const [stats, recentOrders] = await Promise.all([
      getOverviewStats(applicationId, context.environment),
      getRecentOrders(5, applicationId),
    ]);

    return NextResponse.json({
      context: {
        application: context.selectedApplication,
        environment: context.environment,
      },
      stats,
      recentOrders,
    });
  } catch (error) {
    console.error("[admin/overview] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch overview data" },
      { status: 500 },
    );
  }
}
