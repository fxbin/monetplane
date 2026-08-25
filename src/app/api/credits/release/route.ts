import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import { releaseReservation } from "@/modules/credits/service";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const context = await resolveApplicationContext(request);

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
    if (name === "CreditReservationNotFoundError") {
      return NextResponse.json(
        { error: "Reservation not found", code: "invalid_state" },
        { status: 404 },
      );
    }
    if (name === "CreditReservationTerminalStateError") {
      return NextResponse.json(
        { error: "Reservation is in terminal state", code: "invalid_state" },
        { status: 409 },
      );
    }
    if (name === "CreditIdempotencyConflictError") {
      return NextResponse.json(
        { error: "Idempotency key conflict", code: "invalid_state" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Failed to release reservation" },
      { status: 500 },
    );
  }
}
