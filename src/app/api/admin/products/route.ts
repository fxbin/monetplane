import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getProductList } from "@/modules/admin/queries";

/**
 * GET /api/admin/products
 *
 * Returns all products with their parent application name.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  try {
    const products = await getProductList();
    return NextResponse.json({ products });
  } catch (error) {
    console.error("[admin/products] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 },
    );
  }
}
