import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import { requireAdmin } from "@/modules/admin/guard";
import {
  getOverviewStats,
  getRecentOrders,
} from "@/server/control-plane/console-queries";
import { getConsoleContext } from "@/server/control-plane/context";

export async function GET() {
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const applicationId = context.selectedApplication?.id;
    const [stats, recentOrders] = applicationId
      ? await Promise.all([
          getOverviewStats(applicationId, context.environment),
          getRecentOrders(5, applicationId),
        ])
      : [
          {
            applications: 0,
            products: 0,
            customers: 0,
            activeProviders: 0,
            orders: 0,
            totalRevenueMinor: 0,
            creditTransactions: 0,
          },
          [],
        ];

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
      { error: adminErrors.failedToFetchOverviewData },
      { status: 500 },
    );
  }
}
