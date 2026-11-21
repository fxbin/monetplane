/**
 * Sanitizes a user-supplied post-login redirect target so it can never leave
 * the MonetPlane origin (blocks protocol-relative `//evil.com`, backslash
 * variants `/\evil.com`, absolute URLs, and control characters).
 */
export function sanitizeLoginCallbackUrl(
  value: unknown,
  fallback = "/overview",
): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;

  // Reject ASCII control characters (including CR/LF/null) and non-root starts.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return fallback;
  }

  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\")
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed, "https://monetplane.invalid");
    if (parsed.origin !== "https://monetplane.invalid") {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
