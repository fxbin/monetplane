/**
 * Runtime migration runner for container deploys.
 *
 * Applies the `drizzle/` journal through the same postgres-js migrator that
 * `drizzle-kit migrate` uses, but depends only on production dependencies —
 * so it ships inside the runtime image (`docker run --rm <image> migrate`).
 * Idempotent: re-running against an up-to-date database applies nothing
 * (proven by tests/integration/migration-upgrade-path.test.ts).
 *
 * Usage: DATABASE_URL=... node --experimental-strip-types scripts/migrate.mts
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getDatabaseUrl } from "../src/config/env.ts";

const client = postgres(getDatabaseUrl(), { max: 1, prepare: false });

try {
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  const applied = await client`
    select count(*)::int as count from drizzle.__drizzle_migrations
  `;
  console.log(
    `[migrate] done — drizzle.__drizzle_migrations now has ${applied[0].count} entries`,
  );
} finally {
  await client.end();
}
