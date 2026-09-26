import { NextResponse } from "next/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { cancelSubscriptionWithJournal } from "@/server/control-plane/billing-operation-actions";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = {
  params: Promise<{ subscriptionId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requirePermission("billing:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ subscriptionId }, context] = await Promise.all([
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

    const operation = await cancelSubscriptionWithJournal(
      context.selectedApplication.id,
      subscriptionId,
      context.environment,
    );
    await recordAuditEntry({
      applicationId: context.selectedApplication?.id ?? null,
      environment: context.environment,
      action: "subscription.cancelled",
      resourceType: "billing_operation",
      resourceId: operation.id,
      metadata: { subscriptionId },
      request: _request,
    });
    return NextResponse.json({ operation });
  } catch (error) {
    console.error("[admin/subscriptions/cancel] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to cancel subscription",
      },
      { status: 400 },
    );
  }
}
