import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getConsoleContext } from "@/server/control-plane/context";
import { refundCustomerPayment } from "@/server/control-plane/customer-workspace";

type RouteContext = {
  params: Promise<{ customerId: string; paymentId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ customerId, paymentId }, context] = await Promise.all([
      params,
      getConsoleContext(),
    ]);
    if (!context.selectedApplication) {
      return NextResponse.json(
        { error: "Select a project first" },
        { status: 400 },
      );
    }

    const refund = await refundCustomerPayment(
      context.selectedApplication.id,
      customerId,
      paymentId,
    );
    return NextResponse.json({ refund });
  } catch (error) {
    console.error("[admin/customers/payments/refund] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to refund payment",
      },
      { status: 400 },
    );
  }
}
