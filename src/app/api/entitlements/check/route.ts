import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import { consumeHostReadQuota } from "@/modules/applications/host-read-guards";
import {
  extractApplicationBearerToken,
  extractCustomerReadToken,
} from "@/modules/applications/security";
import {
  CustomerReadTokenError,
  resolveCustomerReadToken,
} from "@/modules/customers/read-tokens";
import { hasEntitlement } from "@/modules/entitlements/service";

function parseEnvironment(
  body: Record<string, unknown>,
): "test" | "live" | undefined {
  if (body.environment === "live") return "live";
  if (body.environment === "test") return "test";
  if (body.environment === undefined) return undefined;
  throw new Error("environment must be 'test' or 'live'");
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Environment is an auth-boundary input in every tier below, so an illegal
  // value is rejected up front (400) rather than coerced or turned into a 500.
  if (
    body.environment !== undefined &&
    body.environment !== "test" &&
    body.environment !== "live"
  ) {
    return NextResponse.json(
      {
        error: "environment must be 'test' or 'live'",
        code: "invalid_environment",
      },
      { status: 400 },
    );
  }

  try {
    // #138: three read-auth tiers — customer read token (mprt_*, scoped to
    // one customer), application credential, then the (rate-limited) host
    // fallback that #127 keeps for branded-host migration.
    const authorizationHeader = request.headers.get("authorization");
    const readTokenValue = extractCustomerReadToken(authorizationHeader);
    if (
      authorizationHeader &&
      !readTokenValue &&
      !extractApplicationBearerToken(authorizationHeader) &&
      authorizationHeader.trim().split(/\s+/)[0]?.toLowerCase() === "bearer"
    ) {
      // A Bearer header that is neither a read token nor an application
      // credential is rejected instead of silently downgrading to the host
      // fallback (round-2 review: no silent downgrade). A malformed
      // `mp_app_`-shaped bearer still falls through to the credential tier,
      // which answers 401 itself.
      throw new CustomerReadTokenError();
    }

    let applicationId: string;
    let externalCustomerId: string;
    let environment: "test" | "live";

    const externalCustomerIdInput =
      typeof body.externalCustomerId === "string"
        ? body.externalCustomerId.trim()
        : "";

    if (readTokenValue) {
      const tokenContext = await resolveCustomerReadToken(readTokenValue);
      applicationId = tokenContext.applicationId;
      externalCustomerId = tokenContext.externalCustomerId;
      environment = tokenContext.environment;
      // A read token is scoped to ONE customer — it cannot enumerate others.
      if (
        externalCustomerIdInput &&
        externalCustomerIdInput !== externalCustomerId
      ) {
        return NextResponse.json(
          {
            error: "Read token is scoped to a different customer",
            code: "customer_mismatch",
          },
          { status: 403 },
        );
      }
      if (body.environment !== undefined && body.environment !== environment) {
        return NextResponse.json(
          {
            error: "Read token is scoped to a different environment",
            code: "environment_mismatch",
          },
          { status: 403 },
        );
      }
    } else {
      const context = await resolveApplicationContext(request);

      // #127 transitional control: host-only reads (branded-host fallback)
      // are rate limited per application+client; credential reads are trusted.
      if (context.source === "host") {
        const quota = consumeHostReadQuota(context.application.id, request);
        if (!quota.allowed) {
          if (quota.anomaly) {
            // First breach of this window only — a flooding attacker must not
            // also flood the logs (round-2 review note).
            console.error(
              `[security] host-only read rate limit exceeded for application ${context.application.id} (${quota.limit}/min); possible enumeration attempt`,
            );
          }
          return NextResponse.json(
            {
              error:
                "Too many requests for this host context — use an application credential",
              code: "rate_limited",
            },
            { status: 429 },
          );
        }
      }

      applicationId = context.application.id;
      externalCustomerId = externalCustomerIdInput;
      environment = parseEnvironment(body) ?? "test";
    }

    const featureKey =
      typeof body.featureKey === "string" ? body.featureKey.trim() : "";

    if (!externalCustomerId || !featureKey) {
      return NextResponse.json(
        { error: "externalCustomerId and featureKey are required" },
        { status: 400 },
      );
    }

    const at =
      typeof body.at === "string" && body.at ? new Date(body.at) : new Date();

    const granted = await hasEntitlement(
      applicationId,
      externalCustomerId,
      featureKey,
      at,
      undefined,
      environment,
    );

    return NextResponse.json({ granted });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "CustomerReadTokenError") {
      return NextResponse.json(
        {
          error: "Read token is invalid or expired",
          code: "read_token_invalid",
        },
        { status: 401 },
      );
    }
    if (
      name === "InvalidApplicationCredentialError" ||
      name === "ApplicationContextNotFoundError"
    ) {
      return NextResponse.json(
        { error: "Unauthorized", code: "unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: "Failed to check entitlement" },
      { status: 500 },
    );
  }
}
