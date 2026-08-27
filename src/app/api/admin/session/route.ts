import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * GET /api/admin/session
 *
 * Returns the current admin session status.
 * Used by the dashboard client to check if the session is alive
 * before making further admin API calls.
 */
export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({
    authenticated: true,
    user: {
      name: session.user.name ?? "Admin",
      email: session.user.email ?? null,
    },
    expires: session.expires,
  });
}
