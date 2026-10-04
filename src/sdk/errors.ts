/**
 * MonetPlane SDK error hierarchy.
 *
 * All errors are provider-neutral. Product code never needs to import
 * or understand provider-specific error types.
 */

export class MonetPlaneError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MonetPlaneError";
  }
}

/** Insufficient available credits for a debit or reservation. */
export class InsufficientCreditsError extends MonetPlaneError {
  constructor(message = "Insufficient available credits") {
    super(message, "insufficient_credits");
    this.name = "InsufficientCreditsError";
  }
}

/** The connected provider does not support the requested capability. */
export class UnsupportedCapabilityError extends MonetPlaneError {
  constructor(message = "Unsupported provider capability") {
    super(message, "unsupported_capability");
    this.name = "UnsupportedCapabilityError";
  }
}

/** The resource is in a state that disallows the requested mutation. */
export class InvalidStateError extends MonetPlaneError {
  constructor(message = "Invalid state for this operation") {
    super(message, "invalid_state");
    this.name = "InvalidStateError";
  }
}

/** The app secret is missing, revoked, or does not match any application. */
export class AuthorizationError extends MonetPlaneError {
  constructor(message = "Unauthorized") {
    super(message, "unauthorized");
    this.name = "AuthorizationError";
  }
}

/** No valid payment provider route exists for the checkout (routing/config). */
export class NoProviderRouteError extends MonetPlaneError {
  constructor(message = "No payment provider route") {
    super(message, "no_provider_route");
    this.name = "NoProviderRouteError";
  }
}

/** The referenced usage meter does not exist. */
export class UsageMeterNotFoundError extends MonetPlaneError {
  constructor(message = "Usage meter not found") {
    super(message, "meter_not_found");
    this.name = "UsageMeterNotFoundError";
  }
}

/** Request validation failed (bad shape, amounts, or keys). */
export class ValidationError extends MonetPlaneError {
  constructor(message = "Invalid request") {
    super(message, "invalid_request");
    this.name = "ValidationError";
  }
}

/** A generic API error returned by the MonetPlane server. */
export class ApiError extends MonetPlaneError {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    body: unknown,
  ) {
    super(message, code);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** Network-level failure (DNS, connection refused, timeout, etc.). */
export class NetworkError extends MonetPlaneError {
  readonly cause: unknown;

  constructor(message = "Network request failed", cause?: unknown) {
    super(message, "network_error");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/**
 * The server response failed its expected shape (SDK-side trust boundary,
 * roundtable batch 2). The SDK previously blind-cast responses, so a
 * server-side shape change surfaced as undefined fields in product code;
 * money fields are guarded and fail fast here instead.
 */
export class MalformedResponseError extends MonetPlaneError {
  constructor(message = "MonetPlane returned a malformed response") {
    super(message, "malformed_response");
    this.name = "MalformedResponseError";
  }
}

/**
 * Convert a fetch response into the most specific SDK error.
 * @internal
 */
export async function responseToError(
  response: Response,
): Promise<MonetPlaneError> {
  let body: unknown;
  let message = `MonetPlane API error (${response.status})`;
  let code = "api_error";

  try {
    body = await response.json();
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      if (typeof obj.error === "string") message = obj.error;
      if (typeof obj.code === "string") code = obj.code;
    }
  } catch {
    // body is not JSON; keep defaults
  }

  switch (code) {
    case "insufficient_credits":
      return new InsufficientCreditsError(message);
    case "unsupported_capability":
      return new UnsupportedCapabilityError(message);
    case "invalid_state":
      return new InvalidStateError(message);
    case "unauthorized":
    case "credential_required":
      return new AuthorizationError(message);
    case "no_provider_route":
      return new NoProviderRouteError(message);
    case "meter_not_found":
      return new UsageMeterNotFoundError(message);
    case "invalid_request":
    case "invalid_environment":
    case "environment_mismatch":
      return new ValidationError(message);
    default:
      // Unknown (including future) codes keep their raw shape on ApiError.
      return new ApiError(message, code, response.status, body);
  }
}
