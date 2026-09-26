import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import {
  createPortalSession,
  PortalServiceError,
} from "@/modules/portal/service";

/**
 * POST /api/portal/sessions — SDK surface (#71).
 *
 * The application backend (mp_app_* bearer) creates a short-lived portal
 * session for ONE of its mapped customers. Returns the portal URL with a
 * one-time token; only the hash is stored. Cross-application sessions are
 * impossible: the application comes from the authenticated context, never
 * from the body.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const context = await resolveApplicationContext(request);

    const externalCustomerId =
      typeof body.externalCustomerId === "string"
        ? body.externalCustomerId.trim()
        : "";
    if (!externalCustomerId) {
      return NextResponse.json(
        { error: "externalCustomerId is required" },
        { status: 400 },
      );
    }

    const environment = body.environment === "live" ? "live" : "test";
    const returnUrl =
      typeof body.returnUrl === "string" ? body.returnUrl.trim() : undefined;

    const session = await createPortalSession({
      applicationId: context.application.id,
      externalCustomerId,
      environment,
      returnUrl,
    });

    const origin = new URL(request.url).origin;
    return NextResponse.json(
      {
        sessionId: session.sessionId,
        portalUrl: `${origin}/portal?token=${session.token}`,
        expiresAt: session.expiresAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof PortalServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }

    const name = error instanceof Error ? error.name : "";
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
    if (name === "ApplicationContextMismatchError") {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Application context mismatch",
          code: "application_context_mismatch",
        },
        { status: 403 },
      );
    }
    console.error("[api/portal/sessions] Error:", error);
    return NextResponse.json(
      { error: "Failed to create portal session" },
      { status: 500 },
    );
  }
}
