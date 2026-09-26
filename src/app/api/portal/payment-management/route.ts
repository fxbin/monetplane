import { NextResponse } from "next/server";
import { PortalServiceError } from "@/modules/portal/service";
import { createPortalPaymentManagementRedirect } from "@/server/control-plane/portal";

/**
 * GET /api/portal/payment-management?token=… — provider-homed redirect (#71).
 *
 * Only reachable when the active provider connection claims the
 * customer_portal capability; otherwise 409. The destination is produced by
 * the provider adapter — MonetPlane never redirects to a URL derived from
 * browser input.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  try {
    const result = await createPortalPaymentManagementRedirect(token, request);
    return NextResponse.redirect(result.url, { status: 302 });
  } catch (error) {
    if (error instanceof PortalServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("[api/portal/payment-management] Error:", error);
    return NextResponse.json(
      { error: "Failed to open payment management" },
      { status: 500 },
    );
  }
}
