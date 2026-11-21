/**
 * Helpers for unwrapping database/driver error chains safely (e.g.
 * drizzle-orm >= 0.44 `DrizzleQueryError`, which wraps the underlying PG error
 * in `error.cause` while setting `error.message` to `"Failed query: ..."`).
 */

function errorChain(error: unknown, maxDepth = 4): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current; depth++) {
    chain.push(current);
    if (typeof current === "object" && current !== null && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return chain;
}

/**
 * True when `error` (or its wrapped `cause` chain) represents a PostgreSQL
 * unique-constraint violation (`23505` or unique/duplicate message).
 */
export function isUniqueConstraintError(error: unknown): boolean {
  for (const item of errorChain(error)) {
    if (
      typeof item === "object" &&
      item !== null &&
      "code" in item &&
      (item as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    if (
      typeof item === "object" &&
      item !== null &&
      "message" in item &&
      typeof (item as { message?: unknown }).message === "string" &&
      /unique|duplicate/i.test((item as { message: string }).message)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when `error` is a Drizzle/PostgreSQL query error whose raw message
 * may contain SQL statements, query parameters, or driver internals.
 */
export function isDatabaseQueryError(error: unknown): boolean {
  for (const item of errorChain(error)) {
    if (item instanceof Error) {
      if (
        item.name === "DrizzleQueryError" ||
        item.name === "PostgresError" ||
        item.message.startsWith("Failed query:")
      ) {
        return true;
      }
    }
    if (
      typeof item === "object" &&
      item !== null &&
      "code" in item &&
      typeof (item as { code?: unknown }).code === "string" &&
      /^[0-9A-Z]{5}$/.test((item as { code: string }).code)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns a user-safe error message for admin routes: suppresses raw SQL /
 * parameter strings from `DrizzleQueryError` / driver errors in favor of
 * `fallback`.
 */
export function safeAdminErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (isDatabaseQueryError(error)) {
    return fallback;
  }
  return error instanceof Error ? error.message : fallback;
}
