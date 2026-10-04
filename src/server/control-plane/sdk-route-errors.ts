import { NextResponse } from "next/server";
import type { ApiErrorCode } from "@/lib/api-error-codes";

/**
 * SDK-surface error mapper (roundtable batch 2): the superset of the
 * per-route ladders it replaces (checkout + credits families). Deliberately
 * dependency-free beyond Next/ApiErrorCode — public SDK routes must not
 * transitively load the admin guard (and through it next-auth), which
 * breaks under test runners that do not mock the auth stack.
 *
 * Codes come from the shared ApiErrorCode union. Unknown errors log loudly
 * and answer a generic 500 — internal messages never leak to SDK callers.
 */

function jsonError(status: number, code: ApiErrorCode, message: string) {
  return NextResponse.json({ error: message, code }, { status });
}

/**
 * SDK-surface error mapper: the superset of the per-route ladders it
 * replaces (checkout + credits families). Codes come from the shared
 * ApiErrorCode union. Unknown errors log loudly and answer a generic 500 —
 * internal messages never leak to SDK callers.
 */
export function sdkRouteError(
  error: unknown,
  fallbackMessage: string,
): NextResponse {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : undefined;

  switch (name) {
    case "InvalidApplicationCredentialError":
    case "ApplicationContextNotFoundError":
      return jsonError(401, "unauthorized", message ?? "Unauthorized");
    case "ApplicationCredentialRequiredError":
      return jsonError(
        401,
        "credential_required",
        "Application credential required",
      );
    case "CallbackUrlNotAllowedError":
      return jsonError(
        400,
        "callback_url_not_allowed",
        message ?? "Callback URL is not allowed for this application",
      );
    case "NoProviderRouteError":
      return jsonError(
        409,
        "no_provider_route",
        message ?? "No payment provider route",
      );
    case "CommerceEnvironmentMismatchError":
      return jsonError(
        400,
        "environment_mismatch",
        message ?? "Environment mismatch",
      );
    case "CreditReservationEnvironmentMismatchError":
      return jsonError(
        409,
        "environment_mismatch",
        "Reservation environment mismatch",
      );
    case "CommerceCustomerNotFoundError":
    case "CreditCustomerNotFoundError":
      return jsonError(404, "invalid_state", "Customer not found");
    case "CommerceCatalogError":
      return jsonError(400, "invalid_state", message ?? "Catalog error");
    case "CommerceProviderConnectionError":
      return jsonError(400, "invalid_state", "Provider connection not found");
    case "UnsupportedProviderCapabilityError":
      return jsonError(
        400,
        "unsupported_capability",
        message ?? "Unsupported capability",
      );
    case "InsufficientCreditsError":
      return jsonError(
        402,
        "insufficient_credits",
        message ?? "Insufficient available credits",
      );
    case "CreditIdempotencyConflictError":
      return jsonError(409, "invalid_state", "Idempotency key conflict");
    case "CreditReservationNotFoundError":
      return jsonError(404, "invalid_state", "Reservation not found");
    case "CreditReservationTerminalStateError":
      return jsonError(
        409,
        "invalid_state",
        "Reservation is in terminal state",
      );
    default:
      console.error("[api] Unhandled error:", error);
      return NextResponse.json({ error: fallbackMessage }, { status: 500 });
  }
}
