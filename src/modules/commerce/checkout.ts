import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { assertAllowedCallbackUrl } from "../applications/service";
import { prices, products } from "../catalog/schema";
import { findApplicationCustomer } from "../customers/service";
import { createProviderCheckout } from "../providers/runtime";
import { getProviderConnection } from "../providers/service";
import { checkoutSessions, orderItems, orders } from "./schema";

export class CommerceCustomerNotFoundError extends Error {
  constructor(message = "Application customer not found") {
    super(message);
    this.name = "CommerceCustomerNotFoundError";
  }
}

export class CommerceCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommerceCatalogError";
  }
}

export class CommerceProviderConnectionError extends Error {
  constructor(message = "Active provider connection not found") {
    super(message);
    this.name = "CommerceProviderConnectionError";
  }
}

export type CreateCommerceCheckoutInput = {
  externalCustomerId: string;
  providerConnectionId: string;
  items: Array<{ priceId: string; quantity: number }>;
  successUrl: string;
  cancelUrl: string;
};

export async function createCommerceCheckout(
  applicationId: string,
  input: CreateCommerceCheckoutInput,
  db: Database = getDb(),
) {
  const applicationCustomer = await findApplicationCustomer(
    applicationId,
    input.externalCustomerId,
    db,
  );
  if (!applicationCustomer) throw new CommerceCustomerNotFoundError();

  const providerConnection = await getProviderConnection(
    applicationId,
    input.providerConnectionId,
    db,
  );
  if (!providerConnection || providerConnection.status !== "active") {
    throw new CommerceProviderConnectionError();
  }

  const successUrl = await assertAllowedCallbackUrl(
    applicationId,
    input.successUrl,
    db,
  );
  const cancelUrl = await assertAllowedCallbackUrl(
    applicationId,
    input.cancelUrl,
    db,
  );

  if (input.items.length === 0) {
    throw new CommerceCatalogError("Checkout requires at least one item");
  }

  const requestedPriceIds = [
    ...new Set(input.items.map((item) => item.priceId)),
  ];
  const catalogRows = await db
    .select({ price: prices, product: products })
    .from(prices)
    .innerJoin(products, eq(prices.productId, products.id))
    .where(
      and(
        inArray(prices.id, requestedPriceIds),
        eq(products.applicationId, applicationId),
        eq(products.status, "active"),
        eq(prices.status, "active"),
      ),
    );

  const catalogByPrice = new Map(
    catalogRows.map((row) => [row.price.id, row] as const),
  );
  if (catalogByPrice.size !== requestedPriceIds.length) {
    throw new CommerceCatalogError(
      "One or more prices do not belong to this application or are inactive",
    );
  }

  const resolvedItems = input.items.map((item) => {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new CommerceCatalogError(
        "Item quantity must be a positive integer",
      );
    }
    const row = catalogByPrice.get(item.priceId);
    if (!row) throw new CommerceCatalogError("Price not found");
    return { ...row, quantity: item.quantity };
  });

  const currencies = new Set(resolvedItems.map((item) => item.price.currency));
  const billingTypes = new Set(
    resolvedItems.map((item) => item.price.billingType),
  );
  if (currencies.size !== 1) {
    throw new CommerceCatalogError("Checkout items must use one currency");
  }
  if (billingTypes.size !== 1) {
    throw new CommerceCatalogError(
      "One-time and recurring prices cannot be mixed in one checkout",
    );
  }

  const billingType = resolvedItems[0]?.price.billingType;
  const billingMode = billingType === "recurring" ? "subscription" : "one_time";
  const recurringIntervals = new Set(
    resolvedItems
      .map((item) => item.price.recurringInterval)
      .filter((value): value is string => Boolean(value)),
  );
  const intervalCounts = new Set(
    resolvedItems
      .map((item) => item.price.intervalCount)
      .filter((value): value is number => value !== null),
  );

  if (
    billingMode === "subscription" &&
    (recurringIntervals.size !== 1 || intervalCounts.size !== 1)
  ) {
    throw new CommerceCatalogError(
      "Recurring checkout items must use the same billing interval",
    );
  }

  const currency = resolvedItems[0]?.price.currency;
  if (!currency) throw new CommerceCatalogError("Checkout currency is missing");

  let totalAmountMinor = 0;
  for (const item of resolvedItems) {
    const lineAmount = item.price.amountMinor * item.quantity;
    if (!Number.isSafeInteger(lineAmount)) {
      throw new CommerceCatalogError(
        "Checkout amount exceeds safe integer range",
      );
    }
    totalAmountMinor += lineAmount;
    if (!Number.isSafeInteger(totalAmountMinor)) {
      throw new CommerceCatalogError(
        "Checkout total exceeds safe integer range",
      );
    }
  }

  const orderId = `ord_${randomUUID()}`;
  const checkoutSessionId = `chk_${randomUUID()}`;

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      applicationId,
      applicationCustomerId: applicationCustomer.id,
      billingMode,
      currency,
      totalAmountMinor,
    });

    await tx.insert(orderItems).values(
      resolvedItems.map((item) => ({
        id: `item_${randomUUID()}`,
        orderId,
        productId: item.product.id,
        priceId: item.price.id,
        quantity: item.quantity,
        unitAmountMinor: item.price.amountMinor,
      })),
    );

    await tx.insert(checkoutSessions).values({
      id: checkoutSessionId,
      applicationId,
      orderId,
      providerConnectionId: providerConnection.id,
      successUrl,
      cancelUrl,
    });
  });

  try {
    const providerCheckout = await createProviderCheckout(
      applicationId,
      providerConnection.id,
      {
        applicationId,
        monetplaneOrderId: orderId,
        monetplaneCustomerId: applicationCustomer.customerId,
        billingMode,
        interval:
          billingMode === "subscription"
            ? (resolvedItems[0]?.price.recurringInterval as "month" | "year")
            : undefined,
        currency,
        items: resolvedItems.map((item) => ({
          productId: item.product.id,
          priceId: item.price.id,
          quantity: item.quantity,
          unitAmountMinor: item.price.amountMinor,
        })),
        successUrl,
        cancelUrl,
      },
      db,
    );

    const [session] = await db
      .update(checkoutSessions)
      .set({
        status: "open",
        providerCheckoutId: providerCheckout.providerCheckoutId,
        checkoutUrl: providerCheckout.checkoutUrl,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(checkoutSessions.id, checkoutSessionId),
          eq(checkoutSessions.applicationId, applicationId),
        ),
      )
      .returning();

    return {
      orderId,
      checkoutSessionId,
      orderStatus: "pending" as const,
      checkoutUrl: providerCheckout.checkoutUrl,
      providerCheckoutId: providerCheckout.providerCheckoutId,
      session,
    };
  } catch (error) {
    await db
      .update(checkoutSessions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(checkoutSessions.id, checkoutSessionId),
          eq(checkoutSessions.applicationId, applicationId),
        ),
      );
    throw error;
  }
}
