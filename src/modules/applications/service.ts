import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import {
  applicationBranding,
  applicationCallbackOrigins,
  applicationCredentials,
  applicationDomains,
  applications,
} from "./schema";
import {
  generateApplicationCredential,
  hashApplicationCredential,
  normalizeCallbackOrigin,
  normalizeHostname,
} from "./security";

export type ApplicationRecord = typeof applications.$inferSelect;

export class ApplicationNotFoundError extends Error {
  constructor(message = "Application not found") {
    super(message);
    this.name = "ApplicationNotFoundError";
  }
}

export class CallbackUrlNotAllowedError extends Error {
  constructor(message = "Callback URL is not allowed for this application") {
    super(message);
    this.name = "CallbackUrlNotAllowedError";
  }
}

export type CreateApplicationInput = {
  slug: string;
  name: string;
  branding?: {
    displayName?: string;
    logoUrl?: string | null;
    primaryColor?: string | null;
    supportEmail?: string | null;
    metadata?: Record<string, unknown>;
  };
};

export async function createApplication(
  input: CreateApplicationInput,
  db: Database = getDb(),
): Promise<ApplicationRecord> {
  const id = `app_${randomUUID()}`;
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();

  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error("Application slug must be lowercase letters, numbers, or hyphens");
  }

  if (!name) {
    throw new Error("Application name is required");
  }

  return db.transaction(async (tx) => {
    const [application] = await tx
      .insert(applications)
      .values({ id, slug, name })
      .returning();

    if (!application) {
      throw new Error("Failed to create application");
    }

    await tx.insert(applicationBranding).values({
      applicationId: application.id,
      displayName: input.branding?.displayName?.trim() || application.name,
      logoUrl: input.branding?.logoUrl ?? null,
      primaryColor: input.branding?.primaryColor ?? null,
      supportEmail: input.branding?.supportEmail ?? null,
      metadata: input.branding?.metadata ?? {},
    });

    return application;
  });
}

export async function registerApplicationDomain(
  applicationId: string,
  hostname: string,
  options: { kind?: string; isPrimary?: boolean } = {},
  db: Database = getDb(),
) {
  const normalizedHostname = normalizeHostname(hostname);
  const id = `dom_${randomUUID()}`;

  return db.transaction(async (tx) => {
    if (options.isPrimary) {
      await tx
        .update(applicationDomains)
        .set({ isPrimary: false })
        .where(eq(applicationDomains.applicationId, applicationId));
    }

    const [domain] = await tx
      .insert(applicationDomains)
      .values({
        id,
        applicationId,
        hostname: normalizedHostname,
        kind: options.kind ?? "billing",
        isPrimary: options.isPrimary ?? false,
      })
      .returning();

    return domain;
  });
}

export async function setApplicationBranding(
  applicationId: string,
  branding: {
    displayName: string;
    logoUrl?: string | null;
    primaryColor?: string | null;
    supportEmail?: string | null;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  const [result] = await db
    .insert(applicationBranding)
    .values({
      applicationId,
      displayName: branding.displayName.trim(),
      logoUrl: branding.logoUrl ?? null,
      primaryColor: branding.primaryColor ?? null,
      supportEmail: branding.supportEmail ?? null,
      metadata: branding.metadata ?? {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: applicationBranding.applicationId,
      set: {
        displayName: branding.displayName.trim(),
        logoUrl: branding.logoUrl ?? null,
        primaryColor: branding.primaryColor ?? null,
        supportEmail: branding.supportEmail ?? null,
        metadata: branding.metadata ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();

  return result;
}

export async function registerCallbackOrigin(
  applicationId: string,
  callbackUrl: string,
  db: Database = getDb(),
) {
  const origin = normalizeCallbackOrigin(callbackUrl);
  const [result] = await db
    .insert(applicationCallbackOrigins)
    .values({
      id: `cb_${randomUUID()}`,
      applicationId,
      origin,
    })
    .onConflictDoNothing()
    .returning();

  if (result) return result;

  const [existing] = await db
    .select()
    .from(applicationCallbackOrigins)
    .where(
      and(
        eq(applicationCallbackOrigins.applicationId, applicationId),
        eq(applicationCallbackOrigins.origin, origin),
      ),
    )
    .limit(1);

  return existing;
}

export async function assertAllowedCallbackUrl(
  applicationId: string,
  callbackUrl: string,
  db: Database = getDb(),
): Promise<string> {
  const origin = normalizeCallbackOrigin(callbackUrl);
  const [allowed] = await db
    .select({ id: applicationCallbackOrigins.id })
    .from(applicationCallbackOrigins)
    .where(
      and(
        eq(applicationCallbackOrigins.applicationId, applicationId),
        eq(applicationCallbackOrigins.origin, origin),
      ),
    )
    .limit(1);

  if (!allowed) {
    throw new CallbackUrlNotAllowedError();
  }

  return callbackUrl;
}

export async function issueApplicationCredential(
  applicationId: string,
  name: string,
  db: Database = getDb(),
) {
  const generated = generateApplicationCredential();
  const [credential] = await db
    .insert(applicationCredentials)
    .values({
      id: `cred_${randomUUID()}`,
      applicationId,
      name: name.trim() || "default",
      secretHash: generated.secretHash,
      secretPrefix: generated.secretPrefix,
    })
    .returning({
      id: applicationCredentials.id,
      applicationId: applicationCredentials.applicationId,
      name: applicationCredentials.name,
      secretPrefix: applicationCredentials.secretPrefix,
      createdAt: applicationCredentials.createdAt,
    });

  if (!credential) {
    throw new Error("Failed to issue application credential");
  }

  return {
    ...credential,
    secret: generated.secret,
  };
}

export async function revokeApplicationCredential(
  applicationId: string,
  credentialId: string,
  db: Database = getDb(),
) {
  const [credential] = await db
    .update(applicationCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(applicationCredentials.id, credentialId),
        eq(applicationCredentials.applicationId, applicationId),
      ),
    )
    .returning({ id: applicationCredentials.id });

  return Boolean(credential);
}

export async function resolveApplicationByHost(
  host: string,
  db: Database = getDb(),
): Promise<ApplicationRecord | null> {
  const hostname = normalizeHostname(host);
  const [row] = await db
    .select({ application: applications })
    .from(applicationDomains)
    .innerJoin(applications, eq(applicationDomains.applicationId, applications.id))
    .where(
      and(
        eq(applicationDomains.hostname, hostname),
        eq(applications.status, "active"),
      ),
    )
    .limit(1);

  return row?.application ?? null;
}

export async function authenticateApplicationCredential(
  secret: string,
  db: Database = getDb(),
): Promise<ApplicationRecord | null> {
  const secretHash = hashApplicationCredential(secret);
  const [row] = await db
    .select({
      application: applications,
      credentialId: applicationCredentials.id,
    })
    .from(applicationCredentials)
    .innerJoin(
      applications,
      eq(applicationCredentials.applicationId, applications.id),
    )
    .where(
      and(
        eq(applicationCredentials.secretHash, secretHash),
        isNull(applicationCredentials.revokedAt),
        eq(applications.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return null;

  await db
    .update(applicationCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(applicationCredentials.id, row.credentialId));

  return row.application;
}
