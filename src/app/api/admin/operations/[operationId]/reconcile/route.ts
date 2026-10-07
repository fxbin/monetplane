import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { reconcileBillingOperation } from "@/server/control-plane/billing-operation-actions";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = {
  params: Promise<{ operationId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requirePermission("billing:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ operationId }, context] = await Promise.all([
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

    const operation = await reconcileBillingOperation(
      context.selectedApplication.id,
      operationId,
      context.environment,
      { id: guard.operatorId, label: guard.name || guard.email },
    );
    await recordAuditEntry({
      applicationId: context.selectedApplication?.id ?? null,
      environment: context.environment,
      action: "operation.reconciled",
      resourceType: "billing_operation",
      resourceId: operation.id,
      metadata: { sourceOperationId: operationId },
      request: _request,
    });
    return NextResponse.json({ operation });
  } catch (error) {
    console.error("[admin/operations/reconcile] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : adminErrors.failedToReconcileBillingOperation,
      },
      { status: 400 },
    );
  }
}
