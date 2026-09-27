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
