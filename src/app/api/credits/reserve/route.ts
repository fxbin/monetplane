import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import { reserveCredits } from "@/modules/credits/service";

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
    if (name === "InsufficientCreditsError") {
      return NextResponse.json(
        {
          error: "Insufficient available credits",
          code: "insufficient_credits",
        },
        { status: 402 },
      );
    }
    if (name === "CreditCustomerNotFoundError") {
      return NextResponse.json(
        { error: "Customer not found", code: "invalid_state" },
        { status: 404 },
      );
    }
    if (name === "CreditIdempotencyConflictError") {
      return NextResponse.json(
        { error: "Idempotency key conflict", code: "invalid_state" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Failed to reserve credits" },
      { status: 500 },
    );
  }
}
