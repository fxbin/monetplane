import type {
  ProviderConnectionContext,
  ProviderOperationFailureKind,
} from "../contract";
import { ProviderOperationError } from "../contract";

/**
 * Shared provider adapter kit (audit A8).
 *
 * The paypal/creem/waffo adapters used to repeat ~150 lines of identical
 * JSON guards, credential access, base-URL resolution, HTTP-fetch-JSON
 * boilerplate, and webhook JSON scaffolding each. This module is the single
 * home for those helpers; adapters import it relatively (unit tests run
 * without a tsconfig-path resolver — same pattern as src/lib/money.ts).
 *
 * Constraints:
 *  - Server-only, no next/react imports (module boundary, pinned by tests).
 *  - Error unification (intentional behavior change, flagged in PR7):
 *    missing credentials used to throw a bare Error from PayPal/Creem
 *    (classified downstream as `outcome_uncertain`, which BLOCKS explicit
 *    retry) and a ProviderOperationError("rejected") from Waffo. The
 *    unified helper throws the classified error: a missing credential is a
 *    deterministic configuration failure — the provider was never called,
 *    so `rejected` is the honest, retry-safe classification
 *    (see classifyProviderOperationFailure + retryBillingOperation in
 *    src/server/control-plane/billing-operation-actions.ts).
 */

export type JsonRecord = Record<string, unknown>;

/**
 * Timeout for provider API calls (audit M1). Provider API calls previously
 * had NO timeout; webhook deliveries already used 8s. Provider APIs can be
 * slower than webhook receivers (OAuth + multi-call operations), so the
 * default is 10s and is overridable per call.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ */
/* JSON guards                                                         */
/* ------------------------------------------------------------------ */

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Non-empty string guard. Whitespace-only values count as empty
 * (trim-empty -> undefined); non-whitespace strings are returned as-is.
 */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Like stringValue, but trims surrounding whitespace before returning. */
export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function recordValue(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

export function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  target: string,
): string | undefined {
  const direct = headers[target];
  if (direct) return direct;
  const normalizedTarget = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedTarget && value) return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Credentials and base URLs                                           */
/* ------------------------------------------------------------------ */

export type ProviderCredentialErrorClass = new (
  message: string,
  failureKind: ProviderOperationFailureKind,
) => Error;

/**
 * Read a required connection credential, failing closed with a CLASSIFIED
 * error (default `ProviderOperationError(..., "rejected")`).
 */
export function requiredCredential(
  connection: ProviderConnectionContext,
  key: string,
  providerLabel: string,
  ErrorClass: ProviderCredentialErrorClass = ProviderOperationError,
): string {
  const value = connection.credentials[key]?.trim();
  if (!value) {
    throw new ErrorClass(
      `${providerLabel} connection is missing the ${key} credential`,
      "rejected",
    );
  }
  return value;
}

/** Resolve the base URL for the connection mode (official + override). */
export function providerBaseUrl(
  connection: ProviderConnectionContext,
  officialUrls: { test: string; live: string },
  configuredUrls?: { test?: string; live?: string },
): string {
  const configured =
    connection.mode === "test" ? configuredUrls?.test : configuredUrls?.live;
  const official =
    connection.mode === "test" ? officialUrls.test : officialUrls.live;
  return (configured ?? official).replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* HTTP + JSON                                                         */
/* ------------------------------------------------------------------ */

export type ProviderFetchJsonOptions = {
  /** Provider label used in error message prefixes (e.g. "PayPal"). */
  provider: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type ProviderFetchJsonResult = {
  status: number;
  statusText: string;
  payload: JsonRecord;
};

function formatStatus(status: number, statusText: string): string {
  return statusText ? `${status} ${statusText}` : `${status}`;
}

/**
 * Fetch JSON from a provider API with a hard timeout, returning
 * `{ status, statusText, payload }`. Non-object JSON bodies and invalid
 * JSON throw a provider-prefixed error. HTTP error STATUS is returned to
 * the caller (not thrown) so adapters keep their own status-based failure
 * classification; transport/parse failures throw.
 */
export async function providerFetchJson(
  url: string,
  init: RequestInit | undefined,
  options: ProviderFetchJsonOptions,
): Promise<ProviderFetchJsonResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    ...init,
    signal:
      init?.signal ??
      AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: JsonRecord = {};
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("not a JSON object");
      payload = parsed;
    } catch {
      throw new Error(
        `${options.provider} returned invalid JSON (${formatStatus(response.status, response.statusText)})`,
      );
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    payload,
  };
}

/**
 * Extract a human-readable error message from a provider error payload,
 * covering the shapes observed across PayPal and Creem APIs:
 * `{ message }`, `{ details: [{ description }] }`, `{ error_description }`,
 * `{ error }` (string or `{ description }` object). Falls back to the
 * provider-prefixed fallback.
 */
export function providerErrorMessage(
  payload: JsonRecord,
  fallback: string,
): string {
  const detail = recordValue(
    (Array.isArray(payload.details) ? payload.details[0] : undefined) ??
      recordValue(payload.error),
  );
  return (
    stringValue(payload.message) ??
    stringValue(detail?.description) ??
    stringValue(payload.error_description) ??
    stringValue(payload.error) ??
    fallback
  );
}

/**
 * Shared HTTP failure classification (project review 2026-10-04, pattern
 * finding 1; roundtable batch 1). All adapters must agree on which provider
 * HTTP statuses are deterministic rejections (safe to retry after the
 * operator fixes the input/config) versus uncertain outcomes: a 4xx means
 * the request never executed server-side → "rejected"; 5xx (and anything
 * else, including 0/unknown) may have executed → "outcome_uncertain", so
 * the journal never blind-retries it. Before this, PayPal only classified
 * 400/422, Creem classified NOTHING as rejected (operators could never
 * retry a deterministic Creem failure), and Waffo treated status 0 as
 * rejected. New adapters must route their HTTP failures through this.
 */
export function classifyHttpFailure(
  status: number,
  message: string,
): ProviderOperationError {
  return new ProviderOperationError(
    message,
    status >= 400 && status < 500 ? "rejected" : "outcome_uncertain",
  );
}

/* ------------------------------------------------------------------ */
/* Webhook JSON scaffold                                               */
/* ------------------------------------------------------------------ */

/**
 * Parse a webhook raw body into a JSON object, throwing provider-labeled
 * errors for invalid JSON / non-object bodies. Field-level validation and
 * event mapping stay adapter-specific (provider event shapes differ).
 */
export function parseWebhookJson(
  rawBody: string,
  providerLabel: string,
): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error(`${providerLabel} webhook body is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${providerLabel} webhook must be a JSON object`);
  }
  return parsed;
}
