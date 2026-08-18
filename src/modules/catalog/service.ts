import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { prices, productGrantConfigs, products } from "./schema";

export type BillingType = "one_time" | "recurring";
export type RecurringInterval = "month" | "year";
export type GrantType = "entitlement" | "credit";

export class CatalogProductNotFoundError extends Error {
  constructor(message = "Product not found for application") {
    super(message);
    this.name = "CatalogProductNotFoundError";
  }
}

function normalizeCatalogKey(value: string, label: string): string {
  const key = value.trim().toLowerCase();
  if (!key || !/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
    throw new Error(
      `${label} must use lowercase letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return key;
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Currency must be a three-letter ISO-style code");
  }
  return currency;
}

function assertMinorUnitAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "Amount must be a non-negative safe integer in minor units",
    );
  }
}

function assertPositiveQuantity(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Credit quantity must be a positive safe integer");
  }
}

async function assertProductForApplication(
  applicationId: string,
  productId: string,
  db: Database,
) {
  const [product] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.applicationId, applicationId),
      ),
    )
    .limit(1);

  if (!product) {
    throw new CatalogProductNotFoundError();
  }

  return product;
}

export async function createProduct(
  input: {
    applicationId: string;
    key: string;
    name: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  const name = input.name.trim();
  if (!name) throw new Error("Product name is required");

  const [product] = await db
    .insert(products)
    .values({
      id: `prod_${randomUUID()}`,
      applicationId: input.applicationId,
      key: normalizeCatalogKey(input.key, "Product key"),
      name,
      description: input.description?.trim() || null,
      metadata: input.metadata ?? {},
    })
    .returning();

  if (!product) throw new Error("Failed to create product");
  return product;
}

export async function createPrice(
  input: {
    applicationId: string;
    productId: string;
    key: string;
    currency: string;
    amountMinor: number;
    billingType: BillingType;
    recurringInterval?: RecurringInterval;
    intervalCount?: number;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  await assertProductForApplication(input.applicationId, input.productId, db);
  assertMinorUnitAmount(input.amountMinor);

  if (input.billingType === "one_time") {
    if (
      input.recurringInterval !== undefined ||
      input.intervalCount !== undefined
    ) {
      throw new Error("One-time prices cannot define a recurring interval");
    }
  } else {
    if (
      input.recurringInterval !== "month" &&
      input.recurringInterval !== "year"
    ) {
      throw new Error("Recurring prices require a month or year interval");
    }
    if (
      input.intervalCount !== undefined &&
      (!Number.isSafeInteger(input.intervalCount) || input.intervalCount < 1)
    ) {
      throw new Error("Recurring interval count must be a positive integer");
    }
  }

  const [price] = await db
    .insert(prices)
    .values({
      id: `price_${randomUUID()}`,
      productId: input.productId,
      key: normalizeCatalogKey(input.key, "Price key"),
      currency: normalizeCurrency(input.currency),
      amountMinor: input.amountMinor,
      billingType: input.billingType,
      recurringInterval:
        input.billingType === "recurring" ? input.recurringInterval : null,
      intervalCount:
        input.billingType === "recurring" ? (input.intervalCount ?? 1) : null,
      metadata: input.metadata ?? {},
    })
    .returning();

  if (!price) throw new Error("Failed to create price");
  return price;
}

export async function addProductGrantConfig(
  input: {
    applicationId: string;
    productId: string;
    grantType: GrantType;
    referenceKey: string;
    quantity?: number;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  await assertProductForApplication(input.applicationId, input.productId, db);

  if (input.grantType === "entitlement" && input.quantity !== undefined) {
    throw new Error("Entitlement grant configs do not use a quantity");
  }
  if (input.grantType === "credit") {
    if (input.quantity === undefined) {
      throw new Error("Credit grant configs require a quantity");
    }
    assertPositiveQuantity(input.quantity);
  }

  const [grant] = await db
    .insert(productGrantConfigs)
    .values({
      id: `grantcfg_${randomUUID()}`,
      productId: input.productId,
      grantType: input.grantType,
      referenceKey: normalizeCatalogKey(
        input.referenceKey,
        "Grant reference key",
      ),
      quantity: input.grantType === "credit" ? input.quantity : null,
      metadata: input.metadata ?? {},
    })
    .returning();

  if (!grant) throw new Error("Failed to create product grant config");
  return grant;
}

export async function listApplicationCatalog(
  applicationId: string,
  db: Database = getDb(),
) {
  const productRows = await db
    .select()
    .from(products)
    .where(eq(products.applicationId, applicationId));

  if (productRows.length === 0) return [];

  const result = [];
  for (const product of productRows) {
    const [priceRows, grantRows] = await Promise.all([
      db.select().from(prices).where(eq(prices.productId, product.id)),
      db
        .select()
        .from(productGrantConfigs)
        .where(eq(productGrantConfigs.productId, product.id)),
    ]);

    result.push({ product, prices: priceRows, grants: grantRows });
  }

  return result;
}
