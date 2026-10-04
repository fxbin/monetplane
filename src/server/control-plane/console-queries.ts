import { and, count, desc, eq, sum } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications } from "@/modules/applications/schema";
import { products } from "@/modules/catalog/schema";
import { orders } from "@/modules/commerce/schema";
import { creditTransactions } from "@/modules/credits/schema";
import { applicationCustomers } from "@/modules/customers/schema";
import { providerConnections } from "@/modules/providers/schema";

/**
 * Console-facing read queries (dashboard lists and counters).
 *
 * These are UI/application-layer reads served to console pages and
 * /api/admin routes; billing-domain writes and contracts stay in
 * src/modules/*. All functions return plain data objects suitable for
 * JSON serialization and perform no mutations.
 */

/**
 * Resolve an ACTIVE application for the console context switch (roundtable
 * batch 3: the route previously selected the row inline). Returns null for
 * unknown/inactive ids — the route answers 404 so in- and out-of-scope
 * unknowns stay indistinguishable (#70).
 */
export async function getActiveConsoleApplication(
  applicationId: string,
  db = getDb(),
): Promise<{ id: string; name: string } | null> {
  const [application] = await db
    .select({ id: applications.id, name: applications.name })
    .from(applications)
    .where(
      and(
        eq(applications.id, applicationId),
        eq(applications.status, "active"),
      ),
    )
    .limit(1);
  return application ?? null;
}

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
