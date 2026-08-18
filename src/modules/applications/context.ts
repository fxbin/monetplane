import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { extractApplicationBearerToken } from "./security";
import {
  authenticateApplicationCredential,
  resolveApplicationByHost,
  type ApplicationRecord,
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
  constructor(message = "Host and credential resolve to different applications") {
    super(message);
    this.name = "ApplicationContextMismatchError";
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
