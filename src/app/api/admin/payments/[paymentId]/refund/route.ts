import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { refundPaymentWithJournal } from "@/server/control-plane/billing-operation-actions";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = {
  params: Promise<{ paymentId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ paymentId }, context] = await Promise.all([
      params,
      getConsoleContext(),
    ]);
    if (!context.selectedApplication) {
      return NextResponse.json({ error: "Select a project first" }, { status: 400 });
    }

    const operation = await refundPaymentWithJournal(
      context.selectedApplication.id,
      paymentId,
      context.environment,
    );
    return NextResponse.json({ operation });
  } catch (error) {
    console.error("[admin/payments/refund] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to refund payment",
      },
      { status: 400 },
    );
  }
}
