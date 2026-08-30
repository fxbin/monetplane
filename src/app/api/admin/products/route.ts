import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getProductList } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const products = await getProductList(context.selectedApplication?.id);
    return NextResponse.json({
      context: {
        application: context.selectedApplication,
        environment: context.environment,
      },
      products,
    });
  } catch (error) {
    console.error("[admin/products] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 },
    );
  }
}
