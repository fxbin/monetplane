import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getOverviewStats, getRecentOrders } from "@/modules/admin/queries";

/**
 * GET /api/admin/overview
 *
 * Returns dashboard overview stats and recent orders.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  try {
    const [stats, recentOrders] = await Promise.all([
      getOverviewStats(),
      getRecentOrders(5),
    ]);

    return NextResponse.json({ stats, recentOrders });
  } catch (error) {
    console.error("[admin/overview] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch overview data" },
      { status: 500 },
    );
  }
}
