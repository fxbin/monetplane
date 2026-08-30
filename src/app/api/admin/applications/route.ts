import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import {
  createApplication,
  issueApplicationCredential,
  registerApplicationDomain,
  registerCallbackOrigin,
} from "@/modules/applications/service";
import {
  CONSOLE_APPLICATION_COOKIE,
  CONSOLE_ENVIRONMENT_COOKIE,
} from "@/server/control-plane/context";

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const name = optionalString(input.name);
  const slug = optionalString(input.slug);
  const hostname = optionalString(input.hostname);
  const callbackOrigin = optionalString(input.callbackOrigin);

  if (!name || !slug) {
    return NextResponse.json(
      { error: "Project name and slug are required" },
      { status: 400 },
    );
  }

  try {
    const application = await createApplication({ name, slug });

    if (hostname) {
      await registerApplicationDomain(application.id, hostname, {
        kind: "billing",
        isPrimary: true,
      });
    }

    if (callbackOrigin) {
      await registerCallbackOrigin(application.id, callbackOrigin);
    }

    const credential = await issueApplicationCredential(
      application.id,
      "Console onboarding server key",
    );

    const response = NextResponse.json(
      {
        application,
        credential: {
          id: credential.id,
          name: credential.name,
          secretPrefix: credential.secretPrefix,
          secret: credential.secret,
        },
      },
      { status: 201 },
    );

    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    };
    response.cookies.set(
      CONSOLE_APPLICATION_COOKIE,
      application.id,
      cookieOptions,
    );
    response.cookies.set(CONSOLE_ENVIRONMENT_COOKIE, "test", cookieOptions);

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create project";
    const status = message.toLowerCase().includes("unique") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
