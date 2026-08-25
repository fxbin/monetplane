import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import { hasEntitlement } from "@/modules/entitlements/service";

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
      context.application.id,
      externalCustomerId,
      featureKey,
      at,
    );

    return NextResponse.json({ granted });
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
    return NextResponse.json(
      { error: "Failed to check entitlement" },
      { status: 500 },
    );
  }
}
