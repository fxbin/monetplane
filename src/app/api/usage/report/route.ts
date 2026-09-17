import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import { reportUsage } from "@/modules/usage/service";

function parseEnvironment(body: Record<string, unknown>): "test" | "live" {
  if (body.environment === "live") return "live";
  if (body.environment === "test" || body.environment === undefined) {
    return "test";
  }
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

    const externalCustomerId =
      typeof body.externalCustomerId === "string"
        ? body.externalCustomerId.trim()
        : "";
    const meterKey =
      typeof body.meterKey === "string" ? body.meterKey.trim() : "";
    const quantity = typeof body.quantity === "number" ? body.quantity : 0;
    const sourceType =
      typeof body.sourceType === "string" ? body.sourceType.trim() : "";
    const sourceId =
      typeof body.sourceId === "string" ? body.sourceId.trim() : "";
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

    if (
      !externalCustomerId ||
      !meterKey ||
      !sourceType ||
      !sourceId ||
      !idempotencyKey
    ) {
      return NextResponse.json(
        {
          error:
            "externalCustomerId, meterKey, quantity, sourceType, sourceId, and idempotencyKey are required",
        },
        { status: 400 },
      );
    }

    const environment = parseEnvironment(body);
    const result = await reportUsage({
      applicationId: context.application.id,
      environment,
      meterKey,
      externalCustomerId,
      quantity,
      sourceType,
      sourceId,
      idempotencyKey,
    });

    return NextResponse.json({
      eventId: result.event.id,
      duplicate: result.duplicate,
      quantity: result.event.quantity,
      occurredAt: result.event.occurredAt,
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
    if (name === "UsageMeterNotFoundError") {
      return NextResponse.json(
        { error: "Usage meter not found", code: "meter_not_found" },
        { status: 404 },
      );
    }
    if (name === "UsageCustomerNotFoundError") {
      return NextResponse.json(
        { error: "Customer not found", code: "invalid_state" },
        { status: 404 },
      );
    }
    if (name === "InvalidUsageEventError") {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Invalid usage event",
          code: "invalid_usage",
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Failed to report usage" },
      { status: 500 },
    );
  }
}
