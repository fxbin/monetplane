export function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();

  if (!value) {
    throw new Error("DATABASE_URL is required");
  }

  if (!value.startsWith("postgres://") && !value.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string");
  }

  return value;
}

export function getAuthSecret(): string {
  const value = process.env.AUTH_SECRET?.trim();

  if (!value) {
    throw new Error("AUTH_SECRET is required");
  }

  return value;
}

/**
 * Centralized environment access (roundtable batch 3). Every secret or
 * tunable that used to be read from `process.env` at its point of use —
 * where a typo or a missing var only surfaced at runtime — resolves here.
 * Getters are cheap and side-effect free; setters stay in the deployment
 * environment, tests mutate process.env and restore in afterEach.
 */

/**
 * Bearer secret for /api/cron/* endpoints. Unset means the endpoints
 * answer 401 (fail closed) — expiry/sweep simply never run without it.
 */
export function getCronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}

/**
 * Bootstrap admin password for the first workspace operator login. Unset
 * disables first-login bootstrap (existing operators use the normal flow).
 */
export function getAdminPassword(): string | undefined {
  return process.env.ADMIN_PASSWORD?.trim() || undefined;
}

/**
 * Raw envelope-encryption key material (base64, must decode to 32 bytes).
 * Structural validation stays with the crypto envelopes that consume it —
 * this getter only centralizes the read.
 */
export function getEncryptionKeyMaterial(): string | undefined {
  return process.env.MONETPLANE_ENCRYPTION_KEY?.trim() || undefined;
}

/** Host-read rate limit per minute (positive safe integer, default 60). */
export function getHostReadLimitPerMinute(): number {
  const parsed = Number(process.env.MONETPLANE_HOST_READ_LIMIT);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 60;
}

/** Host-read limiter capacity: tracked client windows (default 10_000). */
export function getHostReadMaxWindows(): number {
  const parsed = Number(process.env.MONETPLANE_HOST_READ_MAX_WINDOWS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 10_000;
}

/** Whether x-forwarded-for may be trusted for host-read bucketing. */
export function isTrustProxyEnabled(): boolean {
  return process.env.MONETPLANE_TRUST_PROXY === "true";
}
