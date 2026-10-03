import { createHash, randomBytes } from "node:crypto";

const APPLICATION_SECRET_PREFIX = "mp_app_";

export class InvalidApplicationHostError extends Error {
  constructor(message = "Invalid application host") {
    super(message);
    this.name = "InvalidApplicationHostError";
  }
}

export class InvalidCallbackUrlError extends Error {
  constructor(message = "Invalid callback URL") {
    super(message);
    this.name = "InvalidCallbackUrlError";
  }
}

export function normalizeHostname(value: string): string {
  const candidate = value.trim().toLowerCase();

  if (!candidate || /[\s,/@\\]/.test(candidate)) {
    throw new InvalidApplicationHostError();
  }

  try {
    const url = new URL(`http://${candidate}`);
    const hostname = url.hostname.replace(/\.$/, "").toLowerCase();

    if (!hostname || hostname.includes("..")) {
      throw new InvalidApplicationHostError();
    }

    return hostname;
  } catch (error) {
    if (error instanceof InvalidApplicationHostError) {
      throw error;
    }

    throw new InvalidApplicationHostError();
  }
}

export function normalizeCallbackOrigin(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new InvalidCallbackUrlError();
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidCallbackUrlError("Callback URL must use http or https");
  }

  if (url.username || url.password) {
    throw new InvalidCallbackUrlError(
      "Callback URL must not contain credentials",
    );
  }

  return url.origin;
}

export function generateApplicationCredential() {
  const token = randomBytes(32).toString("base64url");
  const secret = `${APPLICATION_SECRET_PREFIX}${token}`;

  return {
    secret,
    secretHash: hashApplicationCredential(secret),
    secretPrefix: `${APPLICATION_SECRET_PREFIX}${token.slice(0, 8)}`,
  };
}

export function hashApplicationCredential(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function extractApplicationBearerToken(
  authorizationHeader: string | null,
): string | null {
  if (!authorizationHeader) return null;

  const [scheme, token, ...extra] = authorizationHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token || extra.length > 0) {
    return null;
  }

  return token.startsWith(APPLICATION_SECRET_PREFIX) ? token : null;
}

/**
 * Round-2 review (#138): extract a customer read token (mprt_*) with the same
 * case-insensitive Bearer parsing and malformed-header rejection as
 * extractApplicationBearerToken — "bearer mprt_x" is equally valid HTTP, and
 * a malformed header must never silently downgrade to the host fallback.
 */
export function extractCustomerReadToken(
  authorizationHeader: string | null,
): string | null {
  if (!authorizationHeader) return null;

  const [scheme, token, ...extra] = authorizationHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token || extra.length > 0) {
    return null;
  }

  return token.startsWith("mprt_") ? token : null;
}
