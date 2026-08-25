import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import { getCreditBalance } from "@/modules/credits/service";

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
