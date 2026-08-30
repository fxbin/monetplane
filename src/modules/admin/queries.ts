import { and, count, desc, eq, sum } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications } from "@/modules/applications/schema";
import { prices, products } from "@/modules/catalog/schema";
import { orders } from "@/modules/commerce/schema";
import { creditAccounts, creditTransactions } from "@/modules/credits/schema";
import { applicationCustomers } from "@/modules/customers/schema";
import { providerConnections } from "@/modules/providers/schema";

/**
 * Admin dashboard queries.
 *
 * All functions return plain data objects suitable for JSON serialization.
 * These are read-only queries — no mutations.
 */

export async function getOverviewStats(
  applicationId?: string,
  providerMode?: "test" | "live",
) {
  const db = getDb();

  const [appCount] = await db
    .select({ count: count() })
    .from(applications)
    .where(applicationId ? eq(applications.id, applicationId) : undefined);
  const [productCount] = await db
    .select({ count: count() })
    .from(products)
    .where(
      applicationId ? eq(products.applicationId, applicationId) : undefined,
    );
  const [customerCount] = await db
    .select({ count: count() })
    .from(applicationCustomers)
    .where(
      applicationId
        ? eq(applicationCustomers.applicationId, applicationId)
        : undefined,
    );
  const [providerCount] = await db
    .select({ count: count() })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.status, "active"),
        applicationId
          ? eq(providerConnections.applicationId, applicationId)
          : undefined,
        providerMode ? eq(providerConnections.mode, providerMode) : undefined,
      ),
    );
  const [orderCount] = await db
    .select({ count: count() })
    .from(orders)
    .where(applicationId ? eq(orders.applicationId, applicationId) : undefined);
  const [revenueSum] = await db
    .select({ total: sum(orders.totalAmountMinor) })
    .from(orders)
    .where(
      and(
        eq(orders.status, "paid"),
        applicationId ? eq(orders.applicationId, applicationId) : undefined,
      ),
    );
  const [txCount] = await db
    .select({ count: count() })
    .from(creditTransactions)
    .where(
      applicationId
        ? eq(creditTransactions.applicationId, applicationId)
        : undefined,
    );

  return {
    applications: appCount?.count ?? 0,
    products: productCount?.count ?? 0,
    customers: customerCount?.count ?? 0,
    activeProviders: providerCount?.count ?? 0,
    orders: orderCount?.count ?? 0,
    totalRevenueMinor: Number(revenueSum?.total ?? 0),
    creditTransactions: txCount?.count ?? 0,
  };
}

export async function getRecentOrders(limit = 10, applicationId?: string) {
  const db = getDb();

  const rows = await db
    .select({
      id: orders.id,
      applicationId: orders.applicationId,
      billingMode: orders.billingMode,
      status: orders.status,
      currency: orders.currency,
      totalAmountMinor: orders.totalAmountMinor,
      createdAt: orders.createdAt,
      externalCustomerId: applicationCustomers.externalCustomerId,
      customerEmail: applicationCustomers.email,
    })
    .from(orders)
    .leftJoin(
      applicationCustomers,
      eq(orders.applicationCustomerId, applicationCustomers.id),
    )
    .where(applicationId ? eq(orders.applicationId, applicationId) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  return rows;
}

export async function getProductList(applicationId?: string) {
  const db = getDb();

  const rows = await db
    .select({
      id: products.id,
      applicationId: products.applicationId,
      applicationName: applications.name,
      key: products.key,
      name: products.name,
      description: products.description,
      status: products.status,
      createdAt: products.createdAt,
    })
    .from(products)
    .leftJoin(applications, eq(products.applicationId, applications.id))
    .where(
      applicationId ? eq(products.applicationId, applicationId) : undefined,
    )
    .orderBy(desc(products.createdAt));

  return rows;
}

export async function getProductPrices(productId: string) {
  const db = getDb();

  return db
    .select({
      id: prices.id,
      key: prices.key,
      currency: prices.currency,
      amountMinor: prices.amountMinor,
      billingType: prices.billingType,
      recurringInterval: prices.recurringInterval,
      intervalCount: prices.intervalCount,
      status: prices.status,
    })
    .from(prices)
    .where(eq(prices.productId, productId))
    .orderBy(desc(prices.createdAt));
}

export async function getProviderList(
  applicationId?: string,
  mode?: "test" | "live",
) {
  const db = getDb();

  const rows = await db
    .select({
      id: providerConnections.id,
      applicationId: providerConnections.applicationId,
      applicationName: applications.name,
      provider: providerConnections.provider,
      name: providerConnections.name,
      mode: providerConnections.mode,
      status: providerConnections.status,
      createdAt: providerConnections.createdAt,
      revokedAt: providerConnections.revokedAt,
    })
    .from(providerConnections)
    .leftJoin(
      applications,
      eq(providerConnections.applicationId, applications.id),
    )
    .where(
      and(
        applicationId
          ? eq(providerConnections.applicationId, applicationId)
          : undefined,
        mode ? eq(providerConnections.mode, mode) : undefined,
      ),
    )
    .orderBy(desc(providerConnections.createdAt));

  return rows;
}

export async function getCustomerList(limit = 50, applicationId?: string) {
  const db = getDb();

  const rows = await db
    .select({
      id: applicationCustomers.id,
      applicationId: applicationCustomers.applicationId,
      applicationName: applications.name,
      externalCustomerId: applicationCustomers.externalCustomerId,
      email: applicationCustomers.email,
      createdAt: applicationCustomers.createdAt,
    })
    .from(applicationCustomers)
    .leftJoin(
      applications,
      eq(applicationCustomers.applicationId, applications.id),
    )
    .where(
      applicationId
        ? eq(applicationCustomers.applicationId, applicationId)
        : undefined,
    )
    .orderBy(desc(applicationCustomers.createdAt))
    .limit(limit);

  return rows;
}

export async function getCustomerCreditBalances(applicationCustomerId: string) {
  const db = getDb();

  return db
    .select({
      id: creditAccounts.id,
      creditType: creditAccounts.creditType,
      availableBalance: creditAccounts.availableBalance,
      reservedBalance: creditAccounts.reservedBalance,
    })
    .from(creditAccounts)
    .where(eq(creditAccounts.applicationCustomerId, applicationCustomerId));
}

export async function getApplicationList() {
  const db = getDb();

  return db
    .select({
      id: applications.id,
      slug: applications.slug,
      name: applications.name,
      status: applications.status,
      createdAt: applications.createdAt,
    })
    .from(applications)
    .orderBy(desc(applications.createdAt));
}
