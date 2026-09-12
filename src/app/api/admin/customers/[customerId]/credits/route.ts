import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getConsoleContext } from "@/server/control-plane/context";
import { grantCustomerCredits } from "@/server/control-plane/customer-workspace";

type RouteContext = {
  params: Promise<{ customerId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ customerId }, context, body] = await Promise.all([
      params,
      getConsoleContext(),
      request.json() as Promise<{
        creditType?: unknown;
        amount?: unknown;
        note?: unknown;
      }>,
    ]);
    if (!context.selectedApplication) {
      return NextResponse.json({ error: "Select a project first" }, { status: 400 });
    }

    const creditType =
      typeof body.creditType === "string" ? body.creditType.trim() : "";
    const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
    const note = typeof body.note === "string" ? body.note : undefined;
    if (!creditType) {
      return NextResponse.json({ error: "Credit type is required" }, { status: 400 });
    }

    const result = await grantCustomerCredits(
      context.selectedApplication.id,
      customerId,
      { creditType, amount, note },
    );
    return NextResponse.json({ transaction: result.transaction });
  } catch (error) {
    console.error("[admin/customers/credits] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to grant credits" },
      { status: 400 },
    );
  }
}
