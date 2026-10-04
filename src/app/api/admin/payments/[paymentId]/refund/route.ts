import { NextResponse } from "next/server";
import { refundPaymentWithJournal } from "@/server/control-plane/billing-operation-actions";
import { adminAction } from "@/server/control-plane/route-helpers";

export const POST = adminAction("billing:write", async (ctx) => {
  const { paymentId } = await ctx.params;
  // The journaled operation owns the payment.refunded audit entry, written
  // atomically with the journal completion (audit A4).
  const operation = await refundPaymentWithJournal(
    ctx.applicationId,
    paymentId,
    ctx.environment,
    { id: ctx.guard.operatorId, label: ctx.guard.name || ctx.guard.email },
  );
  return NextResponse.json({ operation });
});
