import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "@/config/env";
import * as schema from "./schema";

type SqlClient = ReturnType<typeof postgres>;

type GlobalWithDatabase = typeof globalThis & {
  __monetplaneSql?: SqlClient;
};

const globalForDatabase = globalThis as GlobalWithDatabase;

function createSqlClient(): SqlClient {
  return postgres(getDatabaseUrl(), {
    max: 5,
    prepare: false,
  });
}

export function getSqlClient(): SqlClient {
  if (!globalForDatabase.__monetplaneSql) {
    globalForDatabase.__monetplaneSql = createSqlClient();
  }

  return globalForDatabase.__monetplaneSql;
}

export function getDb() {
  return drizzle(getSqlClient(), { schema });
}

export type Database = ReturnType<typeof getDb>;
