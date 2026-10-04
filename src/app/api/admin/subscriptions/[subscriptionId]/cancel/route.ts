import { NextResponse } from "next/server";
import { cancelSubscriptionWithJournal } from "@/server/control-plane/billing-operation-actions";
import { adminAction } from "@/server/control-plane/route-helpers";

export const POST = adminAction("billing:write", async (ctx) => {
  const { subscriptionId } = await ctx.params;
  // The journaled operation owns the subscription.cancelled audit entry,
  // written atomically with the journal completion (audit A4).
  const operation = await cancelSubscriptionWithJournal(
    ctx.applicationId,
    subscriptionId,
    ctx.environment,
    { id: ctx.guard.operatorId, label: ctx.guard.name || ctx.guard.email },
  );
  return NextResponse.json({ operation });
});
