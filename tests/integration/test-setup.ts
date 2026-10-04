import { afterAll } from "vitest";
import { getSqlClient } from "../../src/db/client";

/**
 * Minimal shared integration-test setup (roundtable batch 1).
 *
 * Scope is deliberately MINIMAL — DB lifecycle + encryption key only. The
 * roundtable explicitly rejected a full fixture-factory project: shared
 * fixture builders grow on demand when a refactor actually needs them
 * (first consumers: the batch-2 webhook.ts split). Until a file is touched
 * for other reasons, its local setup stays as-is; migrate on touch.
 */

/** The standard integration-test encryption key (32 ASCII bytes, base64). */
export const INTEGRATION_ENCRYPTION_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

/** Sets the shared test encryption key (idempotent, module scope). */
export function enableTestEncryption(): void {
  process.env.MONETPLANE_ENCRYPTION_KEY = INTEGRATION_ENCRYPTION_KEY;
}

/**
 * Registers the shared per-file teardown: drop the test encryption key and
 * close the process-wide SQL client. Call once per test file, at module
 * scope (replaces each file's hand-rolled afterAll).
 */
export function registerIntegrationTeardown(): void {
  afterAll(async () => {
    delete process.env.MONETPLANE_ENCRYPTION_KEY;
    await getSqlClient().end({ timeout: 1 });
  });
}

/** One-call per-file setup: encryption key + teardown registration. */
export function setupIntegrationFile(): void {
  enableTestEncryption();
  registerIntegrationTeardown();
}
