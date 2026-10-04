import { NextResponse } from "next/server";
import { resolveCredentialApplicationContext } from "@/modules/applications";
import { releaseReservation } from "@/modules/credits/service";
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

    const reservationId =
      typeof body.reservationId === "string" ? body.reservationId.trim() : "";
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

    if (!reservationId || !idempotencyKey) {
      return NextResponse.json(
        { error: "reservationId and idempotencyKey are required" },
        { status: 400 },
      );
    }

    const result = await releaseReservation({
      applicationId: context.application.id,
      environment: parseEnvironment(body),
      reservationId,
      idempotencyKey,
      metadata:
        body.metadata && typeof body.metadata === "object"
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });

    return NextResponse.json({
      transactionId: result.transaction?.id ?? null,
      duplicate: result.duplicate,
    });
  } catch (error) {
    return sdkRouteError(error, "Failed to release reservation");
  }
}
