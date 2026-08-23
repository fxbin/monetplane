import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client";
import { productGrantConfigs, products } from "../catalog/schema";
import { grantCreditsInTransaction } from "./service";

type CommerceCreditDb = Pick<
  Database,
  "select" | "insert" | "update" | "execute"
>;

export async function grantConfiguredCreditsInTransaction(
  input: {
    applicationId: string;
    applicationCustomerId: string;
    productItems: Array<{ productId: string; quantity: number }>;
    transactionType: "grant.purchase" | "grant.subscription";
    sourceType: "order" | "subscription";
    sourceId: string;
    periodKey: string;
    sourceEventId?: string | null;
  },
  db: CommerceCreditDb,
) {
  if (input.productItems.length === 0) return [];

  const quantityByProduct = new Map<string, number>();
  for (const item of input.productItems) {
    const next = (quantityByProduct.get(item.productId) ?? 0) + item.quantity;
    if (!Number.isSafeInteger(next) || next <= 0) {
      throw new Error("Configured credit product quantity exceeds safe range");
    }
    quantityByProduct.set(item.productId, next);
  }

  const productIds = [...quantityByProduct.keys()];
  const configs = await db
    .select({
      productId: productGrantConfigs.productId,
      creditType: productGrantConfigs.referenceKey,
      grantQuantity: productGrantConfigs.quantity,
    })
    .from(productGrantConfigs)
    .innerJoin(products, eq(productGrantConfigs.productId, products.id))
    .where(
      and(
        inArray(productGrantConfigs.productId, productIds),
        eq(productGrantConfigs.grantType, "credit"),
        eq(products.applicationId, input.applicationId),
      ),
    );

  const amountByCreditType = new Map<string, number>();
  for (const config of configs) {
    if (
      config.grantQuantity === null ||
      !Number.isSafeInteger(config.grantQuantity) ||
      config.grantQuantity <= 0
    ) {
      throw new Error(
        "Credit grant configuration requires a positive quantity",
      );
    }

    const itemQuantity = quantityByProduct.get(config.productId) ?? 0;
    const grantAmount = config.grantQuantity * itemQuantity;
    const next = (amountByCreditType.get(config.creditType) ?? 0) + grantAmount;
    if (!Number.isSafeInteger(grantAmount) || !Number.isSafeInteger(next)) {
      throw new Error("Configured credit grant exceeds safe integer range");
    }
    amountByCreditType.set(config.creditType, next);
  }

  const results = [];
  for (const [creditType, amount] of amountByCreditType) {
    if (amount <= 0) continue;
    results.push(
      await grantCreditsInTransaction(
        {
          applicationId: input.applicationId,
          applicationCustomerId: input.applicationCustomerId,
          creditType,
          amount,
          transactionType: input.transactionType,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          idempotencyKey: `grant:${input.sourceType}:${input.sourceId}:${input.periodKey}:${creditType}`,
          metadata: input.sourceEventId
            ? { sourceEventId: input.sourceEventId }
            : {},
        },
        db,
      ),
    );
  }

  return results;
}
