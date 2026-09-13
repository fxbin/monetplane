import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { cancelSubscriptionWithJournal } from "@/server/control-plane/billing-operation-actions";
import { getConsoleContext } from "@/server/control-plane/context";
import { getCustomerWorkspace } from "@/server/control-plane/customer-workspace";

type RouteContext = {
  params: Promise<{ customerId: string; subscriptionId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ customerId, subscriptionId }, context] = await Promise.all([
      params,
      getConsoleContext(),
    ]);
    if (!context.selectedApplication) {
      return NextResponse.json(
        { error: "Select a project first" },
        { status: 400 },
      );
    }

    const workspace = await getCustomerWorkspace(
      context.selectedApplication.id,
      customerId,
    );
    if (
      !workspace.subscriptions.some(
        (subscription) => subscription.id === subscriptionId,
      )
    ) {
      throw new Error("Subscription not found for this customer");
    }

    const operation = await cancelSubscriptionWithJournal(
      context.selectedApplication.id,
      subscriptionId,
      context.environment,
    );
    return NextResponse.json({ operation });
  } catch (error) {
    console.error("[admin/customers/subscriptions/cancel] Error:", error);
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
