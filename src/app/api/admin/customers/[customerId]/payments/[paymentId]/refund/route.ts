import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
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
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requirePermission("billing:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ customerId, paymentId }, context] = await Promise.all([
      params,
      getConsoleContext(),
    ]);
    if (!context.selectedApplication) {
      return NextResponse.json(
        { error: adminErrors.selectAProjectFirst },
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

    // The journaled operation owns the payment.refunded audit entry, written
    // atomically with the journal completion (audit A4 — this route previously
    // performed the same operation with no audit trail).
    const operation = await refundPaymentWithJournal(
      context.selectedApplication.id,
      paymentId,
      context.environment,
      { id: guard.operatorId, label: guard.name || guard.email },
    );
    return NextResponse.json({ operation });
  } catch (error) {
    console.error("[admin/customers/payments/refund] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : adminErrors.failedToRefundPayment,
      },
      { status: 400 },
    );
  }
}
