import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import {
  createApplicationCustomer,
  findApplicationCustomer,
} from "@/modules/customers/service";

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

    const existing = await findApplicationCustomer(
      context.application.id,
      externalCustomerId,
    );

    if (existing) {
      return NextResponse.json({
        id: existing.id,
        applicationId: existing.applicationId,
        customerId: existing.customerId,
        externalCustomerId: existing.externalCustomerId,
        email: existing.email,
        metadata: existing.metadata,
      });
    }

    const customer = await createApplicationCustomer({
      applicationId: context.application.id,
      externalCustomerId,
      email: typeof body.email === "string" ? body.email : null,
      metadata:
        body.metadata && typeof body.metadata === "object"
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });

    return NextResponse.json(
      {
        id: customer.id,
        applicationId: customer.applicationId,
        customerId: customer.customerId,
        externalCustomerId: customer.externalCustomerId,
        email: customer.email,
        metadata: customer.metadata,
      },
      { status: 201 },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "InvalidApplicationCredentialError"
    ) {
      return NextResponse.json(
        { error: error.message, code: "unauthorized" },
        { status: 401 },
      );
    }
    if (
      error instanceof Error &&
      error.name === "ApplicationContextNotFoundError"
    ) {
      return NextResponse.json(
        { error: error.message, code: "unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: "Failed to upsert customer" },
      { status: 500 },
    );
  }
}
