import { getSqlClient } from "../../src/db/client";

/**
 * Integration tests share one PostgreSQL service. Reset the application-owned
 * graph explicitly instead of weakening production foreign-key semantics just
 * so tests can delete aggregate roots with historical references.
 */
export async function resetIntegrationDatabase(): Promise<void> {
  await getSqlClient().unsafe(
    'TRUNCATE TABLE "applications", "customers" RESTART IDENTITY CASCADE',
  );
}
