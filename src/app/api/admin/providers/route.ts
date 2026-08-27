import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getProviderList } from "@/modules/admin/queries";

/**
 * GET /api/admin/providers
 *
 * Returns all provider connections with their parent application name.
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
    const providers = await getProviderList();
    return NextResponse.json({ providers });
  } catch (error) {
    console.error("[admin/providers] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch providers" },
      { status: 500 },
    );
  }
}
