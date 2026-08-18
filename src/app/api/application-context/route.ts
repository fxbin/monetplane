import { NextResponse } from "next/server";
import {
  ApplicationContextMismatchError,
  ApplicationContextNotFoundError,
  InvalidApplicationCredentialError,
  resolveApplicationContext,
} from "@/modules/applications";

export async function GET(request: Request) {
  try {
    const context = await resolveApplicationContext(request);

    return NextResponse.json({
      application: {
        id: context.application.id,
        slug: context.application.slug,
        name: context.application.name,
      },
      source: context.source,
    });
  } catch (error) {
    if (error instanceof InvalidApplicationCredentialError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    if (error instanceof ApplicationContextMismatchError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    if (error instanceof ApplicationContextNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    return NextResponse.json(
      { error: "Failed to resolve application context" },
      { status: 500 },
    );
  }
}
