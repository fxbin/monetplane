import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getCustomerList } from "@/server/control-plane/console-queries";
import { getConsoleContext } from "@/server/control-plane/context";

export async function GET() {
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const customers = await getCustomerList(
      100,
      context.selectedApplication?.id,
    );
    return NextResponse.json({
      context: {
        application: context.selectedApplication,
        environment: context.environment,
      },
      customers,
    });
  } catch (error) {
    console.error("[admin/customers] Error:", error);
    return NextResponse.json(
      { error: adminErrors.failedToFetchCustomers },
      { status: 500 },
    );
  }
}
