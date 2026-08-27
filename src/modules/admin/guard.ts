import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Admin API guard — verifies the request has a valid Auth.js session.
 *
 * This is separate from the SDK Bearer token auth used on /api/* routes.
 * Admin API routes live under /api/admin/* and use cookie-based sessions.
 *
 * Usage:
 * ```ts
 * import { requireAdmin } from "@/modules/admin/guard";
 *
 * export async function GET(request: Request) {
 *   const guard = requireAdmin();
 *   if (guard instanceof NextResponse) return guard;
 *   // ... proceed with authenticated logic
 * }
 * ```
 */
export async function requireAdmin() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  return session;
}
