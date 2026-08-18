import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { applicationCustomers, customers } from "./schema";

export type CreateApplicationCustomerInput = {
  applicationId: string;
  externalCustomerId: string;
  customerId?: string;
  email?: string | null;
  metadata?: Record<string, unknown>;
};

export class CustomerNotFoundError extends Error {
  constructor(message = "Customer not found") {
    super(message);
    this.name = "CustomerNotFoundError";
  }
}

export async function createApplicationCustomer(
  input: CreateApplicationCustomerInput,
  db: Database = getDb(),
) {
  const externalCustomerId = input.externalCustomerId.trim();
  if (!externalCustomerId) {
    throw new Error("External customer ID is required");
  }

  return db.transaction(async (tx) => {
    let customerId = input.customerId;

    if (customerId) {
      const [existingCustomer] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);

      if (!existingCustomer) {
        throw new CustomerNotFoundError();
      }
    } else {
      customerId = `cus_${randomUUID()}`;
      await tx.insert(customers).values({ id: customerId });
    }

    const [mapping] = await tx
      .insert(applicationCustomers)
      .values({
        id: `acus_${randomUUID()}`,
        applicationId: input.applicationId,
        customerId,
        externalCustomerId,
        email: input.email?.trim().toLowerCase() || null,
        metadata: input.metadata ?? {},
      })
      .returning();

    if (!mapping) {
      throw new Error("Failed to create application customer");
    }

    return mapping;
  });
}

export async function findApplicationCustomer(
  applicationId: string,
  externalCustomerId: string,
  db: Database = getDb(),
) {
  const [mapping] = await db
    .select()
    .from(applicationCustomers)
    .where(
      and(
        eq(applicationCustomers.applicationId, applicationId),
        eq(
          applicationCustomers.externalCustomerId,
          externalCustomerId.trim(),
        ),
      ),
    )
    .limit(1);

  return mapping ?? null;
}

export async function updateApplicationCustomerMetadata(
  applicationId: string,
  externalCustomerId: string,
  input: { email?: string | null; metadata?: Record<string, unknown> },
  db: Database = getDb(),
) {
  const [mapping] = await db
    .update(applicationCustomers)
    .set({
      email:
        input.email === undefined
          ? undefined
          : input.email?.trim().toLowerCase() || null,
      metadata: input.metadata,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(applicationCustomers.applicationId, applicationId),
        eq(
          applicationCustomers.externalCustomerId,
          externalCustomerId.trim(),
        ),
      ),
    )
    .returning();

  return mapping ?? null;
}
