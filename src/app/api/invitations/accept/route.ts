import { NextResponse } from "next/server";
import { acceptInvitation, TeamServiceError } from "@/modules/team/service";

/**
 * POST /api/invitations/accept — public invitation redemption.
 *
 * Security: the token is a 256-bit random value stored only as a SHA-256
 * hash; acceptance requires the pending, unexpired invitation. This endpoint
 * never grants console access by itself — the invitee still signs in with
 * their own new credentials, and their session carries only their role.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : "";
    const name = typeof body.name === "string" ? body.name : undefined;
    const password = typeof body.password === "string" ? body.password : "";

    if (!token) {
      return NextResponse.json(
        { error: "Invitation token is required" },
        { status: 400 },
      );
    }

    const result = await acceptInvitation({ token, name, password });
    return NextResponse.json({ email: result.email });
  } catch (error) {
    if (error instanceof TeamServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("[invitations/accept] Error:", error);
    return NextResponse.json(
      { error: "Failed to accept invitation" },
      { status: 500 },
    );
  }
}
