import { NextResponse } from "next/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { refundPaymentWithJournal } from "@/server/control-plane/billing-operation-actions";
import { getConsoleContext } from "@/server/control-plane/context";
import { getCustomerWorkspace } from "@/server/control-plane/customer-workspace";

type RouteContext = {
  params: Promise<{ customerId: string; paymentId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requirePermission("billing:write");
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

    const scopeCheck = requireApplicationAccess(
      guard,
      context.selectedApplication.id,
    );
    if (scopeCheck) return scopeCheck;

    const workspace = await getCustomerWorkspace(
      context.selectedApplication.id,
      customerId,
      context.environment,
    );
    if (!workspace.payments.some((payment) => payment.id === paymentId)) {
      throw new Error("Payment not found for this customer");
    }

    const operation = await refundPaymentWithJournal(
      context.selectedApplication.id,
      paymentId,
      context.environment,
    );
    return NextResponse.json({ operation });
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
