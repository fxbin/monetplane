import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { retryBillingOperation } from "@/server/control-plane/billing-operation-actions";
import { getConsoleContext } from "@/server/control-plane/context";

type RouteContext = {
  params: Promise<{ operationId: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ operationId }, context] = await Promise.all([
      params,
      getConsoleContext(),
    ]);
    if (!context.selectedApplication) {
      return NextResponse.json(
        { error: "Select a project first" },
        { status: 400 },
      );
    }

    const operation = await retryBillingOperation(
      context.selectedApplication.id,
      operationId,
      context.environment,
    );
    return NextResponse.json({ operation });
  } catch (error) {
    console.error("[admin/operations/retry] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to retry billing operation",
      },
      { status: 400 },
    );
  }
}
