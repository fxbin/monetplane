import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { productGrantConfigs, products } from "../catalog/schema";
import { applicationCustomers } from "../customers/schema";
import { entitlementGrants } from "./schema";

export type EntitlementSourceType = "order" | "subscription" | "admin";
export type EntitlementStatus = "active" | "revoked" | "expired";

type EntitlementDb = Pick<Database, "select" | "insert" | "update">;

export class EntitlementIdempotencyConflictError extends Error {
  constructor(message = "Entitlement idempotency key already represents another grant") {
    super(message);
    this.name = "EntitlementIdempotencyConflictError";
  }
}

export class EntitlementCustomerNotFoundError extends Error {
  constructor(message = "Application customer not found for entitlement check") {
    super(message);
    this.name = "EntitlementCustomerNotFoundError";
  }
}

function normalizeFeatureKey(value: string): string {
  const featureKey = value.trim().toLowerCase();
  if (!featureKey || !/^[a-z0-9][a-z0-9._-]*$/.test(featureKey)) {
    throw new Error(
      "Feature key must use lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  return featureKey;
}

function assertValidWindow(validFrom: Date, validUntil: Date | null): void {
  if (Number.isNaN(validFrom.getTime())) {
    throw new Error("Entitlement validFrom must be a valid date");
  }
  if (validUntil && Number.isNaN(validUntil.getTime())) {
    throw new Error("Entitlement validUntil must be a valid date");
  }
  if (validUntil && validUntil <= validFrom) {
    throw new Error("Entitlement validUntil must be after validFrom");
  }
}

function sameDate(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

export async function grantEntitlement(
  input: {
    applicationId: string;
    applicationCustomerId: string;
    featureKey: string;
    sourceType: EntitlementSourceType;
    sourceId: string;
    sourceEventId?: string | null;
    idempotencyKey: string;
    validFrom: Date;
    validUntil?: Date | null;
    metadata?: Record<string, unknown>;
  },
  db: EntitlementDb = getDb(),
) {
  const featureKey = normalizeFeatureKey(input.featureKey);
  const sourceId = input.sourceId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const validUntil = input.validUntil ?? null;

  if (!sourceId) throw new Error("Entitlement sourceId is required");
  if (!idempotencyKey) throw new Error("Entitlement idempotencyKey is required");
  assertValidWindow(input.validFrom, validUntil);

  const [inserted] = await db
    .insert(entitlementGrants)
    .values({
      id: `ent_${randomUUID()}`,
      applicationId: input.applicationId,
      applicationCustomerId: input.applicationCustomerId,
      featureKey,
      sourceType: input.sourceType,
      sourceId,
      sourceEventId: input.sourceEventId?.trim() || null,
      idempotencyKey,
      validFrom: input.validFrom,
      validUntil,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [
        entitlementGrants.applicationId,
        entitlementGrants.idempotencyKey,
      ],
    })
    .returning();

  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.applicationId, input.applicationId),
        eq(entitlementGrants.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error("Entitlement grant conflict occurred without a stored grant");
  }

  if (
    existing.applicationCustomerId !== input.applicationCustomerId ||
    existing.featureKey !== featureKey ||
    existing.sourceType !== input.sourceType ||
    existing.sourceId !== sourceId ||
    existing.validFrom.getTime() !== input.validFrom.getTime() ||
    !sameDate(existing.validUntil, validUntil)
  ) {
    throw new EntitlementIdempotencyConflictError();
  }

  return existing;
}

export async function grantConfiguredEntitlements(
  input: {
    applicationId: string;
    applicationCustomerId: string;
    productIds: string[];
    sourceType: "order" | "subscription";
    sourceId: string;
    sourceEventId?: string | null;
    validFrom: Date;
    validUntil?: Date | null;
    periodKey: string;
  },
  db: EntitlementDb = getDb(),
) {
  if (input.productIds.length === 0) return [];

  const rows = await db
    .select({ referenceKey: productGrantConfigs.referenceKey })
    .from(productGrantConfigs)
    .innerJoin(products, eq(productGrantConfigs.productId, products.id))
    .where(
      and(
        inArray(productGrantConfigs.productId, [...new Set(input.productIds)]),
        eq(productGrantConfigs.grantType, "entitlement"),
        eq(products.applicationId, input.applicationId),
      ),
    );

  const featureKeys = [...new Set(rows.map((row) => row.referenceKey))];
  const grants = [];
  for (const featureKey of featureKeys) {
    grants.push(
      await grantEntitlement(
        {
          applicationId: input.applicationId,
          applicationCustomerId: input.applicationCustomerId,
          featureKey,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceEventId: input.sourceEventId,
          idempotencyKey: `${input.sourceType}:${input.sourceId}:${input.periodKey}:${featureKey}`,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
        },
        db,
      ),
    );
  }

  return grants;
}

export async function revokeEntitlementsBySource(
  applicationId: string,
  sourceType: "order" | "subscription",
  sourceId: string,
  db: EntitlementDb = getDb(),
) {
  return db
    .update(entitlementGrants)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(entitlementGrants.applicationId, applicationId),
        eq(entitlementGrants.sourceType, sourceType),
        eq(entitlementGrants.sourceId, sourceId),
        eq(entitlementGrants.status, "active"),
      ),
    )
    .returning();
}

export async function expireEntitlementsBySource(
  applicationId: string,
  sourceType: "subscription",
  sourceId: string,
  db: EntitlementDb = getDb(),
) {
  return db
    .update(entitlementGrants)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(entitlementGrants.applicationId, applicationId),
        eq(entitlementGrants.sourceType, sourceType),
        eq(entitlementGrants.sourceId, sourceId),
        eq(entitlementGrants.status, "active"),
      ),
    )
    .returning();
}

export async function hasEntitlementForApplicationCustomer(
  applicationId: string,
  applicationCustomerId: string,
  featureKey: string,
  at: Date = new Date(),
  db: EntitlementDb = getDb(),
): Promise<boolean> {
  const normalizedFeatureKey = normalizeFeatureKey(featureKey);
  if (Number.isNaN(at.getTime())) throw new Error("Entitlement check date is invalid");

  const [grant] = await db
    .select({ id: entitlementGrants.id })
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.applicationId, applicationId),
        eq(entitlementGrants.applicationCustomerId, applicationCustomerId),
        eq(entitlementGrants.featureKey, normalizedFeatureKey),
        eq(entitlementGrants.status, "active"),
        lte(entitlementGrants.validFrom, at),
        or(
          isNull(entitlementGrants.validUntil),
          gt(entitlementGrants.validUntil, at),
        ),
      ),
    )
    .limit(1);

  return Boolean(grant);
}

export async function hasEntitlement(
  applicationId: string,
  externalCustomerId: string,
  featureKey: string,
  at: Date = new Date(),
  db: EntitlementDb = getDb(),
): Promise<boolean> {
  const [mapping] = await db
    .select({ id: applicationCustomers.id })
    .from(applicationCustomers)
    .where(
      and(
        eq(applicationCustomers.applicationId, applicationId),
        eq(applicationCustomers.externalCustomerId, externalCustomerId),
      ),
    )
    .limit(1);

  if (!mapping) return false;
  return hasEntitlementForApplicationCustomer(
    applicationId,
    mapping.id,
    featureKey,
    at,
    db,
  );
}
