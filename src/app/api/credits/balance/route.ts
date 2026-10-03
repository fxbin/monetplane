import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import { consumeHostReadQuota } from "@/modules/applications/host-read-guards";
import { getCreditBalance } from "@/modules/credits/service";

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

    const externalCustomerId =
      typeof body.externalCustomerId === "string"
        ? body.externalCustomerId.trim()
        : "";
    const creditType =
      typeof body.creditType === "string" ? body.creditType.trim() : "";

    if (!externalCustomerId || !creditType) {
      return NextResponse.json(
        { error: "externalCustomerId and creditType are required" },
        { status: 400 },
      );
    }

    const result = await getCreditBalance(
      context.application.id,
      externalCustomerId,
      creditType,
      undefined,
      parseEnvironment(body),
    );

    return NextResponse.json(result);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
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
