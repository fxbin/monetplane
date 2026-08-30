import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getCustomerList } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";

export async function GET() {
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
      { error: "Failed to fetch customers" },
      { status: 500 },
    );
  }
}
