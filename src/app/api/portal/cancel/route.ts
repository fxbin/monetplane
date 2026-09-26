import { NextResponse } from "next/server";
import { PortalServiceError } from "@/modules/portal/service";
import { cancelSubscriptionFromPortal } from "@/server/control-plane/portal";

/**
 * POST /api/portal/cancel — customer-initiated cancellation (#71).
 *
 * Authenticated by the portal session token (not an operator session, not an
 * SDK credential). The subscription must belong to the session's own
 * application customer; the provider must claim subscription_cancel.
 * The action goes through the shared billing-operation journal and is
 * audited with actor_type customer_portal.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const subscriptionId =
    typeof body.subscriptionId === "string" ? body.subscriptionId : "";
  if (!token || !subscriptionId) {
    return NextResponse.json(
      { error: "token and subscriptionId are required" },
      { status: 400 },
    );
  }

  try {
    const operation = await cancelSubscriptionFromPortal(
      token,
      subscriptionId,
      request,
    );
    return NextResponse.json({
      operation: {
        id: operation.id,
        type: operation.type,
        status: operation.status,
      },
    });
  } catch (error) {
    if (error instanceof PortalServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    if (
      error instanceof Error &&
      error.name === "UnsupportedProviderCapabilityError"
    ) {
      return NextResponse.json(
        {
          error: "The connected provider does not support cancellation",
          code: "capability_unsupported",
        },
        { status: 409 },
      );
    }
    console.error("[api/portal/cancel] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to cancel subscription",
      },
      { status: 400 },
    );
  }
}
