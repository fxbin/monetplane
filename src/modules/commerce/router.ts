import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { products } from "@/modules/catalog/schema";
import { getProviderCapabilities } from "@/modules/providers/runtime";
import { providerConnections } from "@/modules/providers/schema";

/**
 * Payment Router v1 (#60).
 *
 * Resolves the provider connection for a checkout from durable
 * application + environment + product configuration so product code never
 * picks a concrete payment provider per request.
 *
 * Routing policy (in priority order):
 *  1. Product metadata `monetplane.providerRouting[environment]` when every
 *     item in the checkout routes to the same connection.
 *  2. The application's single active connection for the environment.
 *  3. Otherwise fail with a provider-neutral error — the router never
 *     guesses between multiple eligible providers.
 */

export type RoutingEnvironment = "test" | "live";
export type CheckoutBillingMode = "one_time" | "subscription";

export type ResolvedProviderRoute = {
  providerConnectionId: string;
  provider: string;
  connectionName: string;
  source: "product" | "default";
};

export class NoProviderRouteError extends Error {
  constructor(message = "No payment provider is configured for this checkout") {
    super(message);
    this.name = "NoProviderRouteError";
  }
}

function readProviderRouting(
  metadata: Record<string, unknown>,
  environment: RoutingEnvironment,
): string | null {
  const monetplane = metadata.monetplane;
  if (
    !monetplane ||
    typeof monetplane !== "object" ||
    Array.isArray(monetplane)
  ) {
    return null;
  }
  const routing = (monetplane as Record<string, unknown>).providerRouting;
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    return null;
  }
  const value = (routing as Record<string, unknown>)[environment];
  return typeof value === "string" && value ? value : null;
}

async function loadActiveConnections(
  applicationId: string,
  environment: RoutingEnvironment,
  db: Database,
) {
  return db
    .select({
      id: providerConnections.id,
      provider: providerConnections.provider,
      name: providerConnections.name,
      status: providerConnections.status,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.applicationId, applicationId),
        eq(providerConnections.mode, environment),
        isNull(providerConnections.revokedAt),
      ),
    );
}

async function assertConnectionUsable(
  applicationId: string,
  connectionId: string,
  environment: RoutingEnvironment,
  billingMode: CheckoutBillingMode,
  activeIds: Set<string>,
  db: Database,
  recurringInterval?: "week" | "month" | "year",
  trialPeriodDays?: number | null,
): Promise<ResolvedProviderRoute> {
  const [connection] = await db
    .select({
      id: providerConnections.id,
      provider: providerConnections.provider,
      name: providerConnections.name,
      status: providerConnections.status,
    })
    .from(providerConnections)
    .where(eq(providerConnections.id, connectionId))
    .limit(1);

  if (
    !connection ||
    !activeIds.has(connection.id) ||
    connection.status !== "active"
  ) {
    throw new NoProviderRouteError(
      "Configured payment provider is not active for this environment",
    );
  }

  // Capability must be validated before any provider invocation.
  const capabilities = await getProviderCapabilities(
    applicationId,
    connection.id,
    db,
  );
  const required =
    billingMode === "one_time" ? "one_time_checkout" : "recurring_subscription";
  if (!capabilities[required]) {
    throw new NoProviderRouteError(
      `Payment provider does not support ${billingMode} checkout in this environment`,
    );
  }

  return {
    providerConnectionId: connection.id,
    provider: connection.provider,
    connectionName: connection.name,
    source: "product",
  };
}

export async function resolveCheckoutProviderRoute(
  input: {
    applicationId: string;
    environment: RoutingEnvironment;
    billingMode: CheckoutBillingMode;
    productIds: string[];
    recurringInterval?: "week" | "month" | "year";
    trialPeriodDays?: number | null;
  },
  db: Database = getDb(),
): Promise<ResolvedProviderRoute> {
  const activeConnections = await loadActiveConnections(
    input.applicationId,
    input.environment,
    db,
  );
  const activeIds = new Set(activeConnections.map((c) => c.id));

  // 1. Product-configured routing (all items must agree).
  const uniqueProductIds = [...new Set(input.productIds)];
  const productRows = uniqueProductIds.length
    ? await db
        .select({
          id: products.id,
          applicationId: products.applicationId,
          metadata: products.metadata,
        })
        .from(products)
        .where(inArray(products.id, uniqueProductIds))
    : [];
  const routes = new Set<string>();
  for (const productId of input.productIds) {
    const row = productRows.find((p) => p.id === productId);
    if (!row || row.applicationId !== input.applicationId) {
      throw new NoProviderRouteError(
        "Checkout item is not in this application",
      );
    }
    const route = readProviderRouting(row.metadata, input.environment);
    if (route) routes.add(route);
  }
  if (routes.size > 1) {
    throw new NoProviderRouteError(
      "Checkout items route to different payment providers for this environment",
    );
  }
  if (routes.size === 1) {
    const [connectionId] = [...routes];
    return assertConnectionUsable(
      input.applicationId,
      connectionId,
      input.environment,
      input.billingMode,
      activeIds,
      db,
      input.recurringInterval,
      input.trialPeriodDays,
    );
  }

  // 2. Single active connection for the environment.
  if (
    activeConnections.length === 1 &&
    activeConnections[0].status === "active"
  ) {
    const connection = activeConnections[0];
    const route = await assertConnectionUsable(
      input.applicationId,
      connection.id,
      input.environment,
      input.billingMode,
      activeIds,
      db,
      input.recurringInterval,
      input.trialPeriodDays,
    );
    return { ...route, source: "default" };
  }

  throw new NoProviderRouteError(
    activeConnections.length === 0
      ? `No active payment provider is connected for this ${input.environment === "test" ? "Sandbox" : "Production"} environment`
      : "Multiple payment providers are connected without a product routing preference",
  );
}
