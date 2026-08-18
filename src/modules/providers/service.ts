import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import type { ProviderConnectionContext, ProviderMode } from "./contract";
import {
  decryptProviderCredentials,
  encryptProviderCredentials,
} from "./crypto";
import { providerConnections } from "./schema";

export type ProviderConnectionView = {
  id: string;
  applicationId: string;
  provider: string;
  name: string;
  mode: ProviderMode;
  status: "active" | "revoked";
  credentialConfigured: true;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

export class ProviderConnectionNotFoundError extends Error {
  constructor(message = "Provider connection not found") {
    super(message);
    this.name = "ProviderConnectionNotFoundError";
  }
}

function toView(
  row: typeof providerConnections.$inferSelect,
): ProviderConnectionView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    provider: row.provider,
    name: row.name,
    mode: row.mode as ProviderMode,
    status: row.status as "active" | "revoked",
    credentialConfigured: true,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
  };
}

export async function createProviderConnection(
  input: {
    applicationId: string;
    provider: string;
    name: string;
    mode: ProviderMode;
    credentials: Record<string, string>;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
): Promise<ProviderConnectionView> {
  const provider = input.provider.trim().toLowerCase();
  const name = input.name.trim();
  if (!provider) throw new Error("Provider is required");
  if (!name) throw new Error("Provider connection name is required");
  if (Object.keys(input.credentials).length === 0) {
    throw new Error("Provider credentials are required");
  }

  const [row] = await db
    .insert(providerConnections)
    .values({
      id: `pconn_${randomUUID()}`,
      applicationId: input.applicationId,
      provider,
      name,
      mode: input.mode,
      encryptedCredentials: encryptProviderCredentials(input.credentials),
      metadata: input.metadata ?? {},
    })
    .returning();

  if (!row) throw new Error("Failed to create provider connection");
  return toView(row);
}

export async function getProviderConnection(
  applicationId: string,
  connectionId: string,
  db: Database = getDb(),
): Promise<ProviderConnectionView | null> {
  const [row] = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.applicationId, applicationId),
      ),
    )
    .limit(1);

  return row ? toView(row) : null;
}

export async function listProviderConnections(
  applicationId: string,
  db: Database = getDb(),
): Promise<ProviderConnectionView[]> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.applicationId, applicationId));
  return rows.map(toView);
}

export async function revokeProviderConnection(
  applicationId: string,
  connectionId: string,
  db: Database = getDb(),
): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(providerConnections)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.applicationId, applicationId),
      ),
    )
    .returning({ id: providerConnections.id });

  return Boolean(row);
}

export async function loadProviderConnectionContext(
  applicationId: string,
  connectionId: string,
  db: Database = getDb(),
): Promise<ProviderConnectionContext> {
  const [row] = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.applicationId, applicationId),
        eq(providerConnections.status, "active"),
      ),
    )
    .limit(1);

  if (!row) throw new ProviderConnectionNotFoundError();

  return {
    id: row.id,
    applicationId: row.applicationId,
    provider: row.provider,
    mode: row.mode as ProviderMode,
    metadata: row.metadata,
    credentials: decryptProviderCredentials(row.encryptedCredentials),
  };
}
