import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { resolveApplicationContext } from "@/modules/applications";
import { consumeHostReadQuota } from "@/modules/applications/host-read-guards";
import { getCreditBalance } from "@/modules/credits/service";
import { resolveCustomerReadToken } from "@/modules/customers/read-tokens";

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

  try {
    // #138: three read-auth tiers — customer read token (mprt_*, scoped to
    // one customer), application credential, then the (rate-limited) host
    // fallback that #127 keeps for branded-host migration.
    const authorization = request.headers.get("authorization") ?? "";
    const bearerValue = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";
    const readTokenValue = bearerValue.startsWith("mprt_") ? bearerValue : null;

    let applicationId: string;
    let externalCustomerId: string;
    let environment: "test" | "live";

    const externalCustomerIdInput =
      typeof body.externalCustomerId === "string"
        ? body.externalCustomerId.trim()
        : "";

    if (readTokenValue) {
      const tokenContext = await resolveCustomerReadToken(
        readTokenValue,
        getDb(),
      );
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

    const creditType =
      typeof body.creditType === "string" ? body.creditType.trim() : "";

    if (!externalCustomerId || !creditType) {
      return NextResponse.json(
        { error: "externalCustomerId and creditType are required" },
        { status: 400 },
      );
    }

    const result = await getCreditBalance(
      applicationId,
      externalCustomerId,
      creditType,
      undefined,
      environment,
    );

    return NextResponse.json(result);
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
    if (name === "CreditCustomerNotFoundError") {
      return NextResponse.json(
        { error: "Customer not found", code: "invalid_state" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "Failed to get credit balance" },
      { status: 500 },
    );
  }
}
