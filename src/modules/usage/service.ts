import { randomUUID } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { applicationCustomers } from "@/modules/customers/schema";
import { usageEvents, usageMeters } from "@/modules/usage/schema";

/**
 * Usage metering engine — first slice (#62).
 *
 * Meters are application-level definitions (shared across environments per
 * the isolation ADR); usage events are environment-isolated and idempotent
 * per (application, environment, idempotencyKey).
 *
 * Credits vs metered usage: credits are a prepaid balance consumed at
 * debit time; metered usage is measured and billed per period. A product
 * uses either prepaid credits OR metered billing for a given capability —
 * reporting usage never touches credit balances, so consumption cannot be
 * double-counted across the two models.
 */

export type UsageBillingScheme = "per_unit" | "included_overage";

export class UsageMeterNotFoundError extends Error {
  constructor(message = "Usage meter not found") {
    super(message);
    this.name = "UsageMeterNotFoundError";
  }
}

export class UsageCustomerNotFoundError extends Error {
  constructor(message = "Application customer not found for usage") {
    super(message);
    this.name = "UsageCustomerNotFoundError";
  }
}

export class InvalidUsageEventError extends Error {
  constructor(message = "Invalid usage event") {
    super(message);
    this.name = "InvalidUsageEventError";
  }
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new InvalidUsageEventError(`${label} is required`);
  return normalized;
}

export async function createUsageMeter(
  input: {
    applicationId: string;
    key: string;
    name: string;
    unit: string;
    currency: string;
    billingScheme: UsageBillingScheme;
    includedQuantity?: number | null;
    perUnitAmountMinor?: number | null;
    overageUnitAmountMinor?: number | null;
  },
  db: Database = getDb(),
) {
  const key = requireText(input.key, "Meter key").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
    throw new InvalidUsageEventError(
      "Meter key must use lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  if (input.billingScheme === "per_unit") {
    const rate = input.perUnitAmountMinor ?? null;
    if (!Number.isSafeInteger(rate) || rate === null || rate < 0) {
      throw new InvalidUsageEventError(
        "per_unit meters require a non-negative per-unit amount",
      );
    }
  } else {
    const included = input.includedQuantity ?? null;
    const overage = input.overageUnitAmountMinor ?? null;
    if (
      !Number.isSafeInteger(included) ||
      included === null ||
      included < 0 ||
      !Number.isSafeInteger(overage) ||
      overage === null ||
      overage < 0
    ) {
      throw new InvalidUsageEventError(
        "included_overage meters require an included quantity and a non-negative overage unit amount",
      );
    }
  }

  const [meter] = await db
    .insert(usageMeters)
    .values({
      id: `meter_${randomUUID()}`,
      applicationId: input.applicationId,
      key,
      name: requireText(input.name, "Meter name"),
      unit: requireText(input.unit, "Meter unit"),
      currency: input.currency.trim().toUpperCase(),
      billingScheme: input.billingScheme,
      includedQuantity:
        input.billingScheme === "included_overage"
          ? input.includedQuantity
          : null,
      perUnitAmountMinor:
        input.billingScheme === "per_unit" ? input.perUnitAmountMinor : null,
      overageUnitAmountMinor:
        input.billingScheme === "included_overage"
          ? input.overageUnitAmountMinor
          : null,
    })
    .returning();
  if (!meter) throw new Error("Failed to create usage meter");
  return meter;
}

export async function getUsageMeterByKey(
  applicationId: string,
  meterKey: string,
  db: Database = getDb(),
) {
  const [meter] = await db
    .select()
    .from(usageMeters)
    .where(
      and(
        eq(usageMeters.applicationId, applicationId),
        eq(usageMeters.key, meterKey.trim().toLowerCase()),
      ),
    )
    .limit(1);
  return meter ?? null;
}

/**
 * Report usage. Idempotent: the same idempotency key in the same
 * environment returns the original event with duplicate=true and never
 * writes a second row — duplicate ingestion cannot double-bill.
 */
export async function reportUsage(
  input: {
    applicationId: string;
    environment: "test" | "live";
    meterKey: string;
    externalCustomerId: string;
    quantity: number;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    occurredAt?: Date;
  },
  db: Database = getDb(),
) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw new InvalidUsageEventError(
      "Usage quantity must be a positive integer",
    );
  }
  const meter = await getUsageMeterByKey(
    input.applicationId,
    input.meterKey,
    db,
  );
  if (!meter) throw new UsageMeterNotFoundError();

  const [customer] = await db
    .select({ id: applicationCustomers.id })
    .from(applicationCustomers)
    .where(
      and(
        eq(applicationCustomers.applicationId, input.applicationId),
        eq(
          applicationCustomers.externalCustomerId,
          requireText(input.externalCustomerId, "externalCustomerId"),
        ),
      ),
    )
    .limit(1);
  if (!customer) throw new UsageCustomerNotFoundError();

  const [inserted] = await db
    .insert(usageEvents)
    .values({
      id: `usage_${randomUUID()}`,
      applicationId: input.applicationId,
      environment: input.environment,
      meterId: meter.id,
      applicationCustomerId: customer.id,
      quantity: input.quantity,
      sourceType: requireText(input.sourceType, "sourceType"),
      sourceId: requireText(input.sourceId, "sourceId"),
      idempotencyKey: requireText(input.idempotencyKey, "idempotencyKey"),
      occurredAt: input.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) return { event: inserted, duplicate: false as const };

  const [existing] = await db
    .select()
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.applicationId, input.applicationId),
        eq(usageEvents.environment, input.environment),
        eq(usageEvents.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing)
    throw new Error("Usage idempotency conflict without a stored event");
  return { event: existing, duplicate: true as const };
}

export type UsagePeriodSummary = {
  meterId: string;
  meterKey: string;
  unit: string;
  currency: string;
  billingScheme: UsageBillingScheme;
  periodStart: Date;
  periodEnd: Date;
  measuredQuantity: number;
  billingQuantity: number;
  includedQuantity: number;
  overageQuantity: number;
  amountMinor: number;
};

/**
 * Provider-neutral billing quantity: deterministic per-period aggregation
 * with included allowance + overage or simple per-unit charging.
 */
export function computeBillingQuantity(
  meter: {
    billingScheme: string;
    includedQuantity: number | null;
    perUnitAmountMinor: number | null;
    overageUnitAmountMinor: number | null;
  },
  measuredQuantity: number,
): {
  billingQuantity: number;
  includedQuantity: number;
  overageQuantity: number;
  amountMinor: number;
} {
  if (meter.billingScheme === "per_unit") {
    const rate = meter.perUnitAmountMinor ?? 0;
    return {
      billingQuantity: measuredQuantity,
      includedQuantity: 0,
      overageQuantity: 0,
      amountMinor: measuredQuantity * rate,
    };
  }
  const included = meter.includedQuantity ?? 0;
  const overage = Math.max(measuredQuantity - included, 0);
  const overageRate = meter.overageUnitAmountMinor ?? 0;
  return {
    billingQuantity: included + overage === 0 ? 0 : overage,
    includedQuantity: Math.min(measuredQuantity, included),
    overageQuantity: overage,
    amountMinor: overage * overageRate,
  };
}

export async function getUsageSummary(
  input: {
    applicationId: string;
    environment: "test" | "live";
    meterKey: string;
    externalCustomerId?: string;
    periodStart: Date;
    periodEnd: Date;
  },
  db: Database = getDb(),
): Promise<UsagePeriodSummary> {
  const meter = await getUsageMeterByKey(
    input.applicationId,
    input.meterKey,
    db,
  );
  if (!meter) throw new UsageMeterNotFoundError();

  let customerId: string | null = null;
  if (input.externalCustomerId) {
    const [customer] = await db
      .select({ id: applicationCustomers.id })
      .from(applicationCustomers)
      .where(
        and(
          eq(applicationCustomers.applicationId, input.applicationId),
          eq(applicationCustomers.externalCustomerId, input.externalCustomerId),
        ),
      )
      .limit(1);
    customerId = customer?.id ?? "__none__";
  }

  const [aggregate] = await db
    .select({
      total: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.applicationId, input.applicationId),
        eq(usageEvents.environment, input.environment),
        eq(usageEvents.meterId, meter.id),
        customerId
          ? eq(usageEvents.applicationCustomerId, customerId)
          : undefined,
        gte(usageEvents.occurredAt, input.periodStart),
        lt(usageEvents.occurredAt, input.periodEnd),
      ),
    );

  const measuredQuantity = Number(aggregate?.total ?? 0);
  const computed = computeBillingQuantity(meter, measuredQuantity);
  return {
    meterId: meter.id,
    meterKey: meter.key,
    unit: meter.unit,
    currency: meter.currency,
    billingScheme: meter.billingScheme as UsageBillingScheme,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    measuredQuantity,
    ...computed,
  };
}
