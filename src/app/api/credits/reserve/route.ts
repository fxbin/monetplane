import { NextResponse } from "next/server";
import { resolveCredentialApplicationContext } from "@/modules/applications";
import { reserveCredits } from "@/modules/credits/service";
import { sdkRouteError } from "@/server/control-plane/sdk-route-errors";

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
    const context = await resolveCredentialApplicationContext(request);

    const externalCustomerId =
      typeof body.externalCustomerId === "string"
        ? body.externalCustomerId.trim()
        : "";
    const creditType =
      typeof body.creditType === "string" ? body.creditType.trim() : "";
    const amount = typeof body.amount === "number" ? body.amount : 0;
    const referenceType =
      typeof body.referenceType === "string" ? body.referenceType.trim() : "";
    const referenceId =
      typeof body.referenceId === "string" ? body.referenceId.trim() : "";
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

    if (
      !externalCustomerId ||
      !creditType ||
      !referenceType ||
      !referenceId ||
      !idempotencyKey
    ) {
      return NextResponse.json(
        {
          error:
            "externalCustomerId, creditType, amount, referenceType, referenceId, and idempotencyKey are required",
        },
        { status: 400 },
      );
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "amount must be a positive safe integer" },
        { status: 400 },
      );
    }

    const expiresAt =
      typeof body.expiresAt === "string" && body.expiresAt
        ? new Date(body.expiresAt)
        : null;

    const result = await reserveCredits({
      applicationId: context.application.id,
      environment: parseEnvironment(body),
      externalCustomerId,
      creditType,
      amount,
      referenceType,
      referenceId,
      idempotencyKey,
      expiresAt,
      metadata:
        body.metadata && typeof body.metadata === "object"
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });

    return NextResponse.json({
      reservationId: result.reservation.id,
      duplicate: result.duplicate,
    });
  } catch (error) {
    return sdkRouteError(error, "Failed to reserve credits");
  }
}
