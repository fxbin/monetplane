import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { resolveCredentialApplicationContext } from "@/modules/applications";
import { revokeCustomerReadToken } from "@/modules/customers/read-tokens";

/** Revoke a customer read token (credential-authenticated, app-scoped). */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ tokenId: string }> },
) {
  const { tokenId } = await context.params;

  try {
    const appContext = await resolveCredentialApplicationContext(request);
    const revoked = await revokeCustomerReadToken(
      { applicationId: appContext.application.id, tokenId },
      getDb(),
    );
    if (!revoked) {
      return NextResponse.json(
        { error: "Read token not found or already revoked", code: "not_found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ revoked: true });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "ApplicationCredentialRequiredError") {
      return NextResponse.json(
        {
          error: "Application credential required",
          code: "credential_required",
        },
        { status: 401 },
      );
    }
    if (
      name === "InvalidApplicationCredentialError" ||
      name === "ApplicationContextNotFoundError"
    ) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Unauthorized",
          code: "unauthorized",
        },
        { status: 401 },
      );
    }
    console.error("[customer-read-tokens] Revoke error:", error);
    return NextResponse.json(
      { error: "Failed to revoke read token" },
      { status: 500 },
    );
  }
}
