import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getCustomerList } from "@/modules/admin/queries";

/**
 * GET /api/admin/customers
 *
 * Returns all application customers with their parent application name.
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
    const customers = await getCustomerList(100);
    return NextResponse.json({ customers });
  } catch (error) {
    console.error("[admin/customers] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch customers" },
      { status: 500 },
    );
  }
}
