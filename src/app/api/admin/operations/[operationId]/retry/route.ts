import { NextResponse } from "next/server";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { retryBillingOperation } from "@/server/control-plane/billing-operation-actions";
import { adminAction } from "@/server/control-plane/route-helpers";

export const POST = adminAction("billing:write", async (ctx) => {
  const { operationId } = await ctx.params;
  const operation = await retryBillingOperation(
    ctx.applicationId,
    operationId,
    ctx.environment,
    { id: ctx.guard.operatorId, label: ctx.guard.name || ctx.guard.email },
  );
  await recordAuditEntry({
    applicationId: ctx.applicationId,
    environment: ctx.environment,
    action: "operation.retried",
    resourceType: "billing_operation",
    resourceId: operation.id,
    metadata: { sourceOperationId: operationId },
    request: ctx.request,
  });
  return NextResponse.json({ operation });
});
