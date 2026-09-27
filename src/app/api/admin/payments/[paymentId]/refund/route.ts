import { NextResponse } from "next/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { refundPaymentWithJournal } from "@/server/control-plane/billing-operation-actions";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = {
  params: Promise<{ paymentId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requirePermission("billing:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ paymentId }, context] = await Promise.all([
      params,
      getConsoleContext(),
    ]);
    if (!context.selectedApplication) {
      return NextResponse.json(
        { error: "Select a project first" },
        { status: 400 },
      );
    }

    const scopeCheck = requireApplicationAccess(
      guard,
      context.selectedApplication.id,
    );
    if (scopeCheck) return scopeCheck;

    // The journaled operation owns the payment.refunded audit entry, written
    // atomically with the journal completion (audit A4).
    const operation = await refundPaymentWithJournal(
      context.selectedApplication.id,
      paymentId,
      context.environment,
      { id: guard.operatorId, label: guard.name || guard.email },
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
