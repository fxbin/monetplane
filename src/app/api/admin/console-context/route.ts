import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/modules/admin/guard";
import { applications } from "@/modules/applications/schema";
import {
  CONSOLE_APPLICATION_COOKIE,
  CONSOLE_ENVIRONMENT_COOKIE,
  type ConsoleEnvironment,
} from "@/server/control-plane/context";

function isEnvironment(value: unknown): value is ConsoleEnvironment {
  return value === "test" || value === "live";
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
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const applicationId =
    typeof input.applicationId === "string" ? input.applicationId : undefined;
  const environment = input.environment;

  if (!applicationId || !isEnvironment(environment)) {
    return NextResponse.json(
      { error: "applicationId and environment are required" },
      { status: 400 },
    );
  }

  const db = getDb();
  const [application] = await db
    .select({ id: applications.id, name: applications.name })
    .from(applications)
    .where(
      and(
        eq(applications.id, applicationId),
        eq(applications.status, "active"),
      ),
    )
    .limit(1);

  if (!application) {
    return NextResponse.json(
      { error: "Application not found" },
      { status: 404 },
    );
  }

  const response = NextResponse.json({
    application: { id: application.id, name: application.name },
    environment,
  });
  const secure = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };

  response.cookies.set(
    CONSOLE_APPLICATION_COOKIE,
    applicationId,
    cookieOptions,
  );
  response.cookies.set(CONSOLE_ENVIRONMENT_COOKIE, environment, cookieOptions);

  return response;
}
