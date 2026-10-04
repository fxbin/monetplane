import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTableName, is, Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema";

/**
 * Schema/migration consistency (project review 2026-10-04, finding 2.1).
 *
 * `drizzle.config.ts` generates migrations from `src/db/schema.ts`. That
 * entrypoint had drifted: 5 module schema files declaring pgTable tables
 * were not re-exported, so `pnpm db:generate` would diff against an
 * incomplete baseline. AGENTS.md hard constraint 6 ("schema.ts and
 * drizzle/ migrations must stay in sync in the same PR") is mechanical
 * here, in the same spirit as tests/module-boundaries.test.ts.
 */

const repoRoot = process.cwd();
const modulesDir = join(repoRoot, "src", "modules");
const migrationsDir = join(repoRoot, "drizzle");

function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...walk(full));
    } else {
      entries.push(full);
    }
  }
  return entries;
}

function relativeToSrcModules(path: string): string {
  // Compare extensionless: the re-export lines omit ".ts".
  return path
    .slice(join(repoRoot, "src", "modules").length + 1)
    .replace(/\.ts$/, "");
}

describe("db schema / migration consistency", () => {
  it("re-exports every module schema file that declares pgTable tables", () => {
    const schemaFiles = walk(modulesDir).filter(
      (path) =>
        /schema(-[\w-]+)?\.ts$/.test(path) &&
        /pgTable\(/.test(readFileSync(path, "utf8")),
    );
    expect(schemaFiles.length).toBeGreaterThan(0);

    const schemaEntrypoint = readFileSync(
      join(repoRoot, "src", "db", "schema.ts"),
      "utf8",
    );
    const reexported = new Set(
      [
        ...schemaEntrypoint.matchAll(
          /export \* from "\.\.\/(modules\/[\w/-]+)";/g,
        ),
      ].map((match) => match[1] as string),
    );

    const missing = schemaFiles
      .map((path) => `modules/${relativeToSrcModules(path)}`)
      .filter((modulePath) => !reexported.has(modulePath));
    expect(
      missing,
      `Module schema files with pgTable that src/db/schema.ts does not re-export: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("exposes exactly the tables the migrations create", () => {
    const exportedValues: unknown[] = Object.values(schema);
    const schemaTables = new Set<string>(
      exportedValues
        .filter((value): value is Table => is(value, Table))
        .map((table) => getTableName(table) as string),
    );
    expect(schemaTables.size).toBeGreaterThan(0);

    const migrationTables = new Set<string>();
    for (const file of walk(migrationsDir).filter((path) =>
      path.endsWith(".sql"),
    )) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /CREATE TABLE (?:IF NOT EXISTS )?"([\w-]+)"/g,
      )) {
        migrationTables.add(match[1] as string);
      }
    }
    expect(migrationTables.size).toBeGreaterThan(0);

    // Migrations contain no DROP/RENAME statements (verified when this test
    // was written), so the CREATE TABLE union is the deployed table set.
    expect(
      [...migrationTables].filter((name) => !schemaTables.has(name)),
      "Tables created by migrations but missing from src/db/schema.ts (stale generate baseline)",
    ).toEqual([]);
    expect(
      [...schemaTables].filter((name) => !migrationTables.has(name)),
      "Tables declared in schema but never created by a migration (AGENTS.md hard constraint 6)",
    ).toEqual([]);
  });

  it("keeps the drizzle journal aligned with the migration files", () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    const sqlFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(journal.entries.length).toBe(sqlFiles.length);

    const tags = journal.entries.map((entry) => `${entry.tag}.sql`).sort();
    expect(tags).toEqual(sqlFiles);
  });
});
