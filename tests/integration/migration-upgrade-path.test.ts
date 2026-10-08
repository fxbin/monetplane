import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Upgrade-path migration discriminator (external review round-4,
 * P0-151-R4-01): fresh-migrate CI proves the journal applies on an EMPTY
 * database, but the drizzle migrator only applies a migration whose
 * journal `when` is STRICTLY GREATER than the last applied
 * `__drizzle_migrations.created_at` (drizzle-orm pg-core dialect:
 * `Number(lastDbMigration.created_at) < migration.folderMillis`). A
 * renumbered migration whose `when` predates the already-deployed
 * predecessor is therefore SILENTLY SKIPPED on every real upgrade
 * environment while fresh CI stays green.
 *
 * This test simulates the actual release path:
 *   1. migrate a scratch database up to main's tip (0020);
 *   2. migrate again with the full branch journal (0020 + 0021);
 *   3. assert 0021 was applied — row count, the provider_catalog_mappings
 *      table with its composite same-app/same-environment foreign keys
 *      (a consistent mapping INSERT commits, an environment-mismatched
 *      one is rejected by the database), and the earlier 0020 constraint
 *      still holding;
 *   4. migrate a third time and assert repeat-safety.
 */
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const drizzleFolder = path.join(repoRoot, "drizzle");
const MAIN_TIP_TAG = "0020_credit_grant_revoked";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the upgrade-path test");
}

const scratchName = `mp_upgrade_${Math.random().toString(36).slice(2, 10)}`;
const scratchUrl = new URL(databaseUrl);
scratchUrl.pathname = `/${scratchName}`;

const admin = postgres(databaseUrl, { max: 1 });
const scratch = postgres(scratchUrl.href, { max: 1 });

afterAll(async () => {
  await scratch.end({ timeout: 1 });
  await admin`DROP DATABASE IF EXISTS ${admin(scratchName)}`;
  await admin.end({ timeout: 1 });
});

async function copyMigrationsFolder(target: string): Promise<void> {
  await fs.mkdir(path.join(target, "meta"), { recursive: true });
  for (const entry of await fs.readdir(drizzleFolder, {
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".sql")) {
      await fs.copyFile(
        path.join(drizzleFolder, entry.name),
        path.join(target, entry.name),
      );
    }
  }
  for (const entry of await fs.readdir(path.join(drizzleFolder, "meta"), {
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      await fs.copyFile(
        path.join(drizzleFolder, "meta", entry.name),
        path.join(target, "meta", entry.name),
      );
    }
  }
}

describe("migration upgrade path (main@0020 → branch 0021)", () => {
  it("applies 0021 on top of a deployed 0020 database and is repeat-safe", async () => {
    // ---- Static journal sanity (catches the bug class before any DB
    // work). The migrator's skip predicate is decided by `when`
    // (`folderMillis`); `idx` strict monotonicity is journal structural
    // integrity — a duplicate or non-monotonic idx indicates a renumber
    // went wrong and is how the round-4 defect was first introduced.
    const journalPath = path.join(drizzleFolder, "meta/_journal.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const mainTipIndex = journal.entries.findIndex(
      (entry) => entry.tag === MAIN_TIP_TAG,
    );
    expect(mainTipIndex, `journal must contain ${MAIN_TIP_TAG}`).toBe(20);
    for (const [i, entry] of journal.entries.entries()) {
      // idx counts from 0 (0000_bootstrap) and must equal array position.
      expect(entry.idx, `entry ${entry.tag} idx`).toBe(i);
      if (i > 0) {
        expect(
          entry.when,
          `${journal.entries[i - 1]?.tag} → ${entry.tag} when must increase`,
        ).toBeGreaterThan(journal.entries[i - 1]?.when ?? 0);
      }
    }

    // ---- Scratch database standing in for "production at main".
    await admin`CREATE DATABASE ${admin(scratchName)}`;
    const db = drizzle(scratch);
    const appliedCount = async (): Promise<number> => {
      const rows = await scratch<
        Array<{ n: number }>
      >`select count(*)::int as n from drizzle.__drizzle_migrations`;
      return rows[0]?.n ?? 0;
    };

    // Pass 1: main's state — the real journal truncated AT main's tip
    // (entries up to and including 0019, exactly what main ships).
    const mainFolder = await fs.mkdtemp(path.join(repoRoot, ".mp-main-"));
    try {
      await copyMigrationsFolder(mainFolder);
      const mainJournal = path.join(mainFolder, "meta/_journal.json");
      const truncated = {
        ...journal,
        entries: journal.entries.slice(0, mainTipIndex + 1),
      };
      await fs.writeFile(mainJournal, JSON.stringify(truncated, null, 2));
      await migrate(db, { migrationsFolder: mainFolder });
    } finally {
      await fs.rm(mainFolder, { recursive: true, force: true });
    }
    expect(await appliedCount()).toBe(21);

    // Pass 2: deploy this branch and migrate — the discriminator.
    // With 0021's `when` earlier than 0020's, the migrator silently
    // skips it here and the count stays 21.
    await migrate(db, { migrationsFolder: drizzleFolder });
    expect(await appliedCount()).toBe(22);

    // 0021 is live: provider_catalog_mappings exists with the composite
    // same-application / same-environment foreign keys enforced by the
    // database itself (#155 DB-layer isolation).
    const mappingTables = await scratch<
      Array<{ n: number }>
    >`select count(*)::int as n from information_schema.tables where table_name = 'provider_catalog_mappings'`;
    expect(mappingTables[0]?.n).toBe(1);
    const mappingFks = await scratch<
      Array<{ conname: string }>
    >`select conname from pg_constraint where conrelid = 'provider_catalog_mappings'::regclass and contype = 'f'`;
    expect(new Set(mappingFks.map((fk) => fk.conname))).toEqual(
      new Set([
        "provider_catalog_mappings_connection_app_fk",
        "provider_catalog_mappings_connection_mode_fk",
        "provider_catalog_mappings_price_fk",
      ]),
    );

    const mapSuffix = randomUUID().slice(0, 8);
    await scratch`insert into applications (id, slug, name) values (${`app_${mapSuffix}`}, ${`upgrade-${mapSuffix}`}, ${`Upgrade ${mapSuffix}`})`;
    await scratch`insert into provider_connections (id, application_id, provider, name, mode, encrypted_credentials, metadata) values (${`pconn_${mapSuffix}`}, ${`app_${mapSuffix}`}, 'creem', ${`creem-${mapSuffix}`}, 'test', 'encrypted', '{}'::jsonb)`;
    await scratch`insert into products (id, application_id, key, name, metadata) values (${`prod_${mapSuffix}`}, ${`app_${mapSuffix}`}, ${`pro-${mapSuffix}`}, ${`Pro ${mapSuffix}`}, '{}'::jsonb)`;
    await scratch`insert into prices (id, product_id, key, currency, amount_minor, billing_type, metadata) values (${`price_${mapSuffix}`}, ${`prod_${mapSuffix}`}, 'default', 'USD', 1900, 'one_time', '{}'::jsonb)`;

    // A CONSISTENT mapping (same app, connection mode matches the
    // environment column) commits.
    await scratch`insert into provider_catalog_mappings (id, application_id, provider_connection_id, environment, monetplane_price_id, provider, provider_product_id, source, status) values (${`pcmap_${mapSuffix}`}, ${`app_${mapSuffix}`}, ${`pconn_${mapSuffix}`}, 'test', ${`price_${mapSuffix}`}, 'creem', ${`creem_prod_${mapSuffix}`}, 'linked', 'synced')`;

    // An INCONSISTENT mapping (environment 'live' on a test-mode
    // connection) is rejected by the composite foreign key — the
    // database-level environment isolation #155 requires.
    await expect(
      scratch`insert into provider_catalog_mappings (id, application_id, provider_connection_id, environment, monetplane_price_id, provider, provider_product_id, source, status) values (${`pcmap_bad_${mapSuffix}`}, ${`app_${mapSuffix}`}, ${`pconn_${mapSuffix}`}, 'live', ${`price_${mapSuffix}`}, 'creem', ${`creem_prod_bad_${mapSuffix}`}, 'linked', 'synced')`,
    ).rejects.toThrow(/provider_catalog_mappings_connection_mode_fk/i);

    // The earlier 0020 constraint is still live: `grant.revoked` is
    // accepted.
    const constraintDefs = await scratch<
      Array<{ def: string }>
    >`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'credit_transactions_type_check'`;
    expect(constraintDefs[0]?.def).toContain("grant.revoked");

    // End-to-end probe: a real clawback ledger row commits on the
    // upgraded schema (minimal parent rows to satisfy foreign keys).
    const suffix = randomUUID().slice(0, 8);
    await scratch`insert into customers (id) values (${`cust_${suffix}`})`;
    await scratch`insert into applications (id, slug, name) values (${`app_${suffix}`}, ${`upgrade-${suffix}`}, ${`Upgrade ${suffix}`})`;
    await scratch`insert into application_customers (id, application_id, customer_id, external_customer_id, metadata) values (${`appc_${suffix}`}, ${`app_${suffix}`}, ${`cust_${suffix}`}, ${`ext_${suffix}`}, '{}'::jsonb)`;
    await scratch`insert into credit_accounts (id, application_id, application_customer_id, credit_type) values (${`acct_${suffix}`}, ${`app_${suffix}`}, ${`appc_${suffix}`}, 'tokens')`;
    await scratch`insert into credit_transactions (id, application_id, application_customer_id, credit_account_id, type, amount, available_after, reserved_after, source_type, source_id, idempotency_key) values (${`ctx_${suffix}`}, ${`app_${suffix}`}, ${`appc_${suffix}`}, ${`acct_${suffix}`}, 'grant.revoked', -100, 0, 0, 'subscription', ${`sub_${suffix}`}, ${`revoke-probe-${suffix}`})`;

    // Pass 3: migrate again — repeat-safe, nothing new applied.
    await migrate(db, { migrationsFolder: drizzleFolder });
    expect(await appliedCount()).toBe(22);
  }, 120_000);
});
