import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { extractApplicationBearerToken } from "./security";
import {
  type ApplicationRecord,
  authenticateApplicationCredential,
  resolveApplicationByHost,
} from "./service";

export type ApplicationContext = {
  application: ApplicationRecord;
  source: "host" | "credential";
};

export class ApplicationContextNotFoundError extends Error {
  constructor(message = "Unable to resolve application context") {
    super(message);
    this.name = "ApplicationContextNotFoundError";
  }
}

export class InvalidApplicationCredentialError extends Error {
  constructor(message = "Invalid application credential") {
    super(message);
    this.name = "InvalidApplicationCredentialError";
  }
}

export class ApplicationContextMismatchError extends Error {
  constructor(
    message = "Host and credential resolve to different applications",
  ) {
    super(message);
    this.name = "ApplicationContextMismatchError";
  }
}

export class ApplicationCredentialRequiredError extends Error {
  constructor(message = "Application credential required") {
    super(message);
    this.name = "ApplicationCredentialRequiredError";
  }
}

export async function resolveApplicationContext(
  request: Request,
  db: Database = getDb(),
): Promise<ApplicationContext> {
  const host = request.headers.get("host");
  const bearerToken = extractApplicationBearerToken(
    request.headers.get("authorization"),
  );

  const hostApplication = host
    ? await resolveApplicationByHost(host, db).catch(() => null)
    : null;

  let credentialApplication: ApplicationRecord | null = null;
  if (bearerToken) {
    credentialApplication = await authenticateApplicationCredential(
      bearerToken,
      db,
    );

    if (!credentialApplication) {
      throw new InvalidApplicationCredentialError();
    }
  }

  if (
    hostApplication &&
    credentialApplication &&
    hostApplication.id !== credentialApplication.id
  ) {
    throw new ApplicationContextMismatchError();
  }

  if (credentialApplication) {
    return {
      application: credentialApplication,
      source: "credential",
    };
  }

  if (hostApplication) {
    return {
      application: hostApplication,
      source: "host",
    };
  }

  throw new ApplicationContextNotFoundError();
}

/**
 * Resolve the application context and require it to come from an
 * authenticated application credential (mp_app_* bearer).
 *
 * The plain `resolveApplicationContext` keeps a Host-header fallback for
 * public/hosted read surfaces (branded domains). Money-mutating SDK routes
 * must NOT trust the Host header: any client that can set the Host to a
 * registered application domain would otherwise act as that application.
 * Mutation routes resolve through this guard and fail with a 401
 * `credential_required` when only the host is present.
 */
export async function resolveCredentialApplicationContext(
  request: Request,
  db: Database = getDb(),
): Promise<ApplicationContext> {
  const context = await resolveApplicationContext(request, db);

  if (context.source !== "credential") {
    throw new ApplicationCredentialRequiredError();
  }

  return context;
}
