import { NextResponse } from "next/server";
import { resolveCredentialApplicationContext } from "@/modules/applications";
import { issueCustomerReadToken } from "@/modules/customers/read-tokens";
import { findApplicationCustomer } from "@/modules/customers/service";

/**
 * Issue a short-lived, customer-scoped READ token (#138 end-state for #127).
 *
 * Application backends authenticate with their `mp_app_*` credential and mint
 * a token for ONE of their customers; browsers on branded-host surfaces then
 * read balances/entitlements with `Authorization: Bearer mprt_*` — scoped to
 * that single customer, environment-bound, mandatory expiry, revocable.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const context = await resolveCredentialApplicationContext(request);

    const externalCustomerId =
      typeof body.externalCustomerId === "string"
        ? body.externalCustomerId.trim()
        : "";
    // Token environment: explicit body value wins; otherwise the minting
    // backend picks it. ApplicationContext carries no environment (connections
    // do). #132 matrix consistency: an explicit but invalid environment is a
    // client error, not a silent default to test.
    let environment: "test" | "live";
    if (body.environment === undefined) {
      environment = "test";
    } else if (body.environment === "live" || body.environment === "test") {
      environment = body.environment;
    } else {
      return NextResponse.json(
        {
          error: "environment must be 'test' or 'live'",
          code: "invalid_environment",
        },
        { status: 400 },
      );
    }
    const ttlSeconds =
      typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined;

    if (!externalCustomerId) {
      return NextResponse.json(
        { error: "externalCustomerId is required" },
        { status: 400 },
      );
    }

    const customer = await findApplicationCustomer(
      context.application.id,
      externalCustomerId,
    );
    if (!customer) {
      return NextResponse.json(
        { error: "Customer not found", code: "customer_not_found" },
        { status: 404 },
      );
    }

    const issued = await issueCustomerReadToken({
      applicationId: context.application.id,
      applicationCustomerId: customer.id,
      environment,
      ttlSeconds,
    });

    return NextResponse.json(
      {
        id: issued.id,
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        externalCustomerId,
        environment,
      },
      { status: 201 },
    );
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
    if (name === "CustomerReadTokenMismatchError") {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Customer binding mismatch",
          code: "customer_application_mismatch",
        },
        { status: 400 },
      );
    }
    if (name === "ApplicationContextMismatchError") {
      // Host and credential resolved to different applications — a client
      // error, never a 500.
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Application binding mismatch",
          code: "application_mismatch",
        },
        { status: 400 },
      );
    }
    if (name === "CustomerReadTokenTtlError") {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Invalid ttl",
          code: "invalid_ttl",
        },
        { status: 400 },
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
    console.error("[customer-read-tokens] Error:", error);
    return NextResponse.json(
      { error: "Failed to issue customer read token" },
      { status: 500 },
    );
  }
}
