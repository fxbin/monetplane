/**
 * Machine-readable error codes for the SDK-FACING surfaces (public /api
 * routes + portal), shared by the routes' response `code` field and the
 * SDK (src/sdk/errors.ts responseToError). Before this module the two
 * sides kept separate word lists and drifted: the SDK never learned
 * `invalid_environment`, and the portal surface emitted both
 * `capability_unsupported` and `unsupported_capability` for the same fact.
 * Console-only admin codes (e.g. `forbidden`) intentionally stay out —
 * the SDK never sees them.
 *
 * - Server: construct error responses with codes from this union (the
 *   route helpers in src/server/control-plane/route-helpers.ts type-check
 *   against it).
 * - SDK: unknown codes degrade to ApiError carrying the raw `code`,
 *   statusCode, and body, so adding a code here never breaks clients.
 */

export const API_ERROR_CODES = [
  // Auth / application context
  "unauthorized",
  "credential_required",
  "project_required",
  // Request validation
  "invalid_request",
  "invalid_environment",
  "invalid_ttl",
  "invalid_usage",
  // State conflicts
  "invalid_state",
  "environment_mismatch",
  // Resource lookup / scope
  "not_found",
  "customer_not_found",
  "meter_not_found",
  "no_provider_route",
  "application_mismatch",
  "application_context_mismatch",
  "customer_mismatch",
  "customer_application_mismatch",
  // Capability / policy
  "unsupported_capability",
  "insufficient_credits",
  "rate_limited",
  "read_token_invalid",
  "callback_url_not_allowed",
  // Portal surface (SDK-facing via createCustomerPortalSession and the
  // hosted portal redirect). The return-url pair is a known naming drift
  // to consolidate when the portal service is next touched.
  "no_provider_connection",
  "portal_session_invalid",
  "portal_session_expired",
  "invalid_return_url",
  "return_url_not_allowed",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
