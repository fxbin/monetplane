import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getActiveConsoleApplication } from "@/server/control-plane/console-queries";
import {
  CONSOLE_APPLICATION_COOKIE,
  CONSOLE_ENVIRONMENT_COOKIE,
  type ConsoleEnvironment,
} from "@/server/control-plane/context";

function isEnvironment(value: unknown): value is ConsoleEnvironment {
  return value === "test" || value === "live";
}

export async function POST(request: Request) {
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: adminErrors.invalidJsonBody },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: adminErrors.invalidRequestBody },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const applicationId =
    typeof input.applicationId === "string" ? input.applicationId : undefined;
  const environment = input.environment;

  if (!applicationId || !isEnvironment(environment)) {
    return NextResponse.json(
      { error: adminErrors.applicationidAndEnvironmentAreRequired },
      { status: 400 },
    );
  }

  const application = await getActiveConsoleApplication(applicationId);

  if (!application) {
    return NextResponse.json(
      { error: adminErrors.applicationNotFound },
      { status: 404 },
    );
  }

  // Restricted members cannot point their console session at an
  // out-of-scope application. Respond 404 (not 403) so in- and out-of-scope
  // unknown applications are indistinguishable (#70).
  if (
    guard.applicationScope === "restricted" &&
    !guard.applicationIds.includes(applicationId)
  ) {
    return NextResponse.json(
      { error: adminErrors.applicationNotFound },
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
