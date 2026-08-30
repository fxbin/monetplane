import { count, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  applicationCallbackOrigins,
  applicationCredentials,
  applicationDomains,
  applications,
} from "@/modules/applications/schema";
import { products } from "@/modules/catalog/schema";
import { applicationCustomers } from "@/modules/customers/schema";
import { providerConnections } from "@/modules/providers/schema";

export async function getConsoleApplicationDetail(applicationId: string) {
  const db = getDb();
  const [application] = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      name: applications.name,
      status: applications.status,
      createdAt: applications.createdAt,
      updatedAt: applications.updatedAt,
    })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);

  if (!application) return null;

  const [domains, callbackOrigins, credentials, productCount, customerCount, providerCount] =
    await Promise.all([
      db
        .select({
          id: applicationDomains.id,
          hostname: applicationDomains.hostname,
          kind: applicationDomains.kind,
          isPrimary: applicationDomains.isPrimary,
          createdAt: applicationDomains.createdAt,
        })
        .from(applicationDomains)
        .where(eq(applicationDomains.applicationId, applicationId)),
      db
        .select({
          id: applicationCallbackOrigins.id,
          origin: applicationCallbackOrigins.origin,
          createdAt: applicationCallbackOrigins.createdAt,
        })
        .from(applicationCallbackOrigins)
        .where(eq(applicationCallbackOrigins.applicationId, applicationId)),
      db
        .select({
          id: applicationCredentials.id,
          name: applicationCredentials.name,
          secretPrefix: applicationCredentials.secretPrefix,
          createdAt: applicationCredentials.createdAt,
          lastUsedAt: applicationCredentials.lastUsedAt,
          revokedAt: applicationCredentials.revokedAt,
        })
        .from(applicationCredentials)
        .where(eq(applicationCredentials.applicationId, applicationId)),
      db
        .select({ count: count() })
        .from(products)
        .where(eq(products.applicationId, applicationId)),
      db
        .select({ count: count() })
        .from(applicationCustomers)
        .where(eq(applicationCustomers.applicationId, applicationId)),
      db
        .select({ count: count() })
        .from(providerConnections)
        .where(eq(providerConnections.applicationId, applicationId)),
    ]);

  return {
    application,
    domains,
    callbackOrigins,
    credentials,
    counts: {
      products: productCount[0]?.count ?? 0,
      customers: customerCount[0]?.count ?? 0,
      providers: providerCount[0]?.count ?? 0,
    },
  };
}
