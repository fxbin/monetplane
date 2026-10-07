/**
 * Boot-time fail-closed preflight for containerized (standalone) deploys.
 *
 * Why this exists: the standalone server bundles src/config/env.ts checks
 * into lazily-loaded route chunks, so a missing AUTH_SECRET no longer
 * crashes the process at boot — every request would 500 instead. This
 * preflight restores the process-level contract (missing required env =>
 * exit before serving anything) by calling the SAME getters, keeping
 * validation single-sourced in src/config/env.ts.
 *
 * Scope is exactly the two env vars whose absence previously crashed the
 * process at module evaluation. Optional vars (CRON_SECRET, ADMIN_PASSWORD)
 * and use-time validation (encryption-key structure) intentionally keep
 * their existing semantics — fail closed where defined, disabled where
 * designed to be optional.
 */
import { getAuthSecret, getDatabaseUrl } from "../src/config/env.ts";

getDatabaseUrl();
getAuthSecret();

console.log("[preflight] DATABASE_URL and AUTH_SECRET present — ok");
