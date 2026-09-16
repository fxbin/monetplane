import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  applicationCredentials,
  issueApplicationCredential,
  revokeApplicationCredential,
} from "@/modules/applications";
import { prices, products } from "@/modules/catalog/schema";
import {
  payments,
  subscriptions,
  webhookEvents,
} from "@/modules/commerce/schema";
import { applicationCustomers } from "@/modules/customers/schema";
import { billingOperations } from "@/modules/operations/schema";
import { providerConnections } from "@/modules/providers/schema";
import {
  listWebhookDeliveries,
  listWebhookEndpoints,
  webhookDeliveries,
} from "@/modules/webhooks";
import type { ConsoleEnvironment } from "./context";

export type DeveloperFilters = {
  provider?: string;
  customer?: string;
  order?: string;
  status?: string;
  type?: string;
  limit?: number;
};

export async function listDeveloperApiKeys(applicationId: string) {
  const db = getDb();
  return db
    .select({
      id: applicationCredentials.id,
      name: applicationCredentials.name,
      secretPrefix: applicationCredentials.secretPrefix,
      createdAt: applicationCredentials.createdAt,
      lastUsedAt: applicationCredentials.lastUsedAt,
      revokedAt: applicationCredentials.revokedAt,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.applicationId, applicationId))
    .orderBy(desc(applicationCredentials.createdAt));
}

export async function createDeveloperApiKey(
  applicationId: string,
  name: string,
) {
  return issueApplicationCredential(applicationId, name);
}

export async function rotateDeveloperApiKey(
  applicationId: string,
  credentialId: string,
) {
  const db = getDb();
  const [existing] = await db
    .select({ id: applicationCredentials.id, name: applicationCredentials.name })
    .from(applicationCredentials)
    .where(
      and(
        eq(applicationCredentials.id, credentialId),
        eq(applicationCredentials.applicationId, applicationId),
        isNull(applicationCredentials.revokedAt),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Active API key not found");

  const replacement = await issueApplicationCredential(
    applicationId,
    existing.name,
    db,
  );
  return {
    ...replacement,
    rotatesCredentialId: existing.id,
    previousKeyStillActive: true,
  };
}

export async function revokeDeveloperApiKey(
  applicationId: string,
  credentialId: string,
) {
  const revoked = await revokeApplicationCredential(applicationId, credentialId);
  if (!revoked) throw new Error("API key not found");
  return { id: credentialId, revoked: true };
}

export async function getDeveloperQuickstart(
  applicationId: string,
  environment: ConsoleEnvironment,
) {
  const db = getDb();
  const [[provider], [catalog]] = await Promise.all([
    db
      .select({
        id: providerConnections.id,
        provider: providerConnections.provider,
        name: providerConnections.name,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.applicationId, applicationId),
          eq(providerConnections.mode, environment),
          eq(providerConnections.status, "active"),
        ),
      )
      .orderBy(providerConnections.createdAt)
      .limit(1),
    db
      .select({
        productId: products.id,
        productName: products.name,
        priceId: prices.id,
        priceKey: prices.key,
      })
      .from(prices)
      .innerJoin(products, eq(products.id, prices.productId))
      .where(
        and(
          eq(products.applicationId, applicationId),
          eq(products.status, "active"),
          eq(prices.status, "active"),
        ),
      )
      .orderBy(products.createdAt, prices.createdAt)
      .limit(1),
  ]);

  return {
    provider: provider ?? null,
    catalog: catalog ?? null,
  };
}

export async function getDeveloperHealth(
  applicationId: string,
  environment: ConsoleEnvironment,
) {
  const db = getDb();
  const [keys, endpoints, deliveries, events, environmentPayments] =
    await Promise.all([
      db
        .select({ lastUsedAt: applicationCredentials.lastUsedAt })
        .from(applicationCredentials)
        .where(
          and(
            eq(applicationCredentials.applicationId, applicationId),
            isNull(applicationCredentials.revokedAt),
          ),
        ),
      listWebhookEndpoints(applicationId, environment, db),
      listWebhookDeliveries(
        applicationId,
        environment,
        { status: "succeeded", limit: 1 },
        db,
      ),
      db
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .innerJoin(
          providerConnections,
          eq(providerConnections.id, webhookEvents.providerConnectionId),
        )
        .where(
          and(
            eq(webhookEvents.applicationId, applicationId),
            eq(providerConnections.mode, environment),
          ),
        )
        .limit(1),
      db
        .select({ id: payments.id })
        .from(payments)
        .innerJoin(
          providerConnections,
          eq(providerConnections.id, payments.providerConnectionId),
        )
        .where(
          and(
            eq(payments.applicationId, applicationId),
            eq(providerConnections.mode, environment),
          ),
        )
        .limit(1),
    ]);

  const activeEndpoints = endpoints.filter((endpoint) => endpoint.status === "active");
  return {
    apiKeyCreated: keys.length > 0,
    apiRequestReceived: keys.some((key) => key.lastUsedAt !== null),
    webhookConfigured: activeEndpoints.length > 0,
    webhookDelivered: deliveries.length > 0,
    firstProviderEventReceived: events.length > 0,
    firstPaymentReceived: environmentPayments.length > 0,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export async function getDeveloperEvents(
  applicationId: string,
  environment: ConsoleEnvironment,
  filters: DeveloperFilters = {},
) {
  const db = getDb();
  const rows = await db
    .select({ event: webhookEvents, provider: providerConnections.provider })
    .from(webhookEvents)
    .innerJoin(
      providerConnections,
      eq(providerConnections.id, webhookEvents.providerConnectionId),
    )
    .where(
      and(
        eq(webhookEvents.applicationId, applicationId),
        eq(providerConnections.mode, environment),
      ),
    )
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(250);

  let customerIds: Set<string> | null = null;
  if (filters.customer) {
    const customers = await db
      .select({
        customerId: applicationCustomers.customerId,
        externalCustomerId: applicationCustomers.externalCustomerId,
      })
      .from(applicationCustomers)
      .where(eq(applicationCustomers.applicationId, applicationId));
    customerIds = new Set(
      customers
        .filter(
          (customer) =>
            customer.customerId === filters.customer ||
            customer.externalCustomerId === filters.customer,
        )
        .flatMap((customer) => [customer.customerId, customer.externalCustomerId]),
    );
  }

  const selected = rows.filter((row) => {
    const normalized = row.event.normalizedEvent;
    const customer =
      stringValue(normalized.monetplaneCustomerId) ??
      stringValue(normalized.externalCustomerId);
    const order = stringValue(normalized.monetplaneOrderId);
    if (
      filters.provider &&
      row.event.providerConnectionId !== filters.provider &&
      row.provider !== filters.provider
    ) {
      return false;
    }
    if (filters.customer && (!customer || !customerIds?.has(customer))) return false;
    if (filters.order && order !== filters.order) return false;
    if (filters.status && row.event.status !== filters.status) return false;
    if (filters.type && row.event.normalizedType !== filters.type) return false;
    return true;
  });

  return selected.slice(0, Math.min(Math.max(filters.limit ?? 100, 1), 200)).map(
    (row) => ({
      id: row.event.id,
      provider: row.provider,
      providerConnectionId: row.event.providerConnectionId,
      providerEventId: row.event.providerEventId,
      providerEventName: row.event.providerEventName,
      type: row.event.normalizedType,
      status: row.event.status,
      orderId: stringValue(row.event.normalizedEvent.monetplaneOrderId),
      customerId: stringValue(row.event.normalizedEvent.monetplaneCustomerId),
      errorMessage: row.event.errorMessage,
      occurredAt: row.event.occurredAt,
      receivedAt: row.event.receivedAt,
      processedAt: row.event.processedAt,
    }),
  );
}

export type DeveloperLogEntry = {
  id: string;
  source: "provider_webhook" | "billing_operation" | "developer_webhook";
  level: "info" | "warning" | "error";
  message: string;
  status: string;
  providerConnectionId: string | null;
  provider: string | null;
  externalCustomerId: string | null;
  orderId: string | null;
  createdAt: Date;
};

export async function getDeveloperLogs(
  applicationId: string,
  environment: ConsoleEnvironment,
  filters: DeveloperFilters = {},
): Promise<DeveloperLogEntry[]> {
  const db = getDb();
  const [eventRows, operationRows, deliveryRows, customerRows, paymentRows, subRows] =
    await Promise.all([
      db
        .select({ event: webhookEvents, provider: providerConnections.provider })
        .from(webhookEvents)
        .innerJoin(
          providerConnections,
          eq(providerConnections.id, webhookEvents.providerConnectionId),
        )
        .where(
          and(
            eq(webhookEvents.applicationId, applicationId),
            eq(providerConnections.mode, environment),
          ),
        )
        .orderBy(desc(webhookEvents.receivedAt))
        .limit(150),
      db
        .select({ operation: billingOperations, provider: providerConnections.provider })
        .from(billingOperations)
        .innerJoin(
          providerConnections,
          eq(providerConnections.id, billingOperations.providerConnectionId),
        )
        .where(
          and(
            eq(billingOperations.applicationId, applicationId),
            eq(providerConnections.mode, environment),
          ),
        )
        .orderBy(desc(billingOperations.createdAt))
        .limit(150),
      listWebhookDeliveries(applicationId, environment, { limit: 150 }, db),
      db
        .select({
          id: applicationCustomers.id,
          customerId: applicationCustomers.customerId,
          externalCustomerId: applicationCustomers.externalCustomerId,
        })
        .from(applicationCustomers)
        .where(eq(applicationCustomers.applicationId, applicationId)),
      db
        .select({
          id: payments.id,
          orderId: payments.orderId,
          customerId: payments.customerId,
        })
        .from(payments)
        .where(eq(payments.applicationId, applicationId)),
      db
        .select({
          id: subscriptions.id,
          applicationCustomerId: subscriptions.applicationCustomerId,
        })
        .from(subscriptions)
        .where(eq(subscriptions.applicationId, applicationId)),
    ]);

  const externalByCustomer = new Map(
    customerRows.map((customer) => [customer.customerId, customer.externalCustomerId]),
  );
  const externalByApplicationCustomer = new Map(
    customerRows.map((customer) => [customer.id, customer.externalCustomerId]),
  );
  const paymentById = new Map(paymentRows.map((payment) => [payment.id, payment]));
  const subscriptionById = new Map(subRows.map((subscription) => [subscription.id, subscription]));

  const logs: DeveloperLogEntry[] = [];
  for (const row of eventRows) {
    const normalized = row.event.normalizedEvent;
    const globalCustomerId = stringValue(normalized.monetplaneCustomerId);
    logs.push({
      id: `event:${row.event.id}`,
      source: "provider_webhook",
      level: row.event.status === "failed" ? "error" : "info",
      message: `${row.event.normalizedType} from ${row.provider}`,
      status: row.event.status,
      providerConnectionId: row.event.providerConnectionId,
      provider: row.provider,
      externalCustomerId: globalCustomerId
        ? externalByCustomer.get(globalCustomerId) ?? globalCustomerId
        : null,
      orderId: stringValue(normalized.monetplaneOrderId),
      createdAt: row.event.receivedAt,
    });
  }

  for (const row of operationRows) {
    let externalCustomerId: string | null = null;
    let orderId: string | null = null;
    if (row.operation.resourceType === "payment") {
      const payment = paymentById.get(row.operation.resourceId);
      orderId = payment?.orderId ?? null;
      externalCustomerId = payment?.customerId
        ? externalByCustomer.get(payment.customerId) ?? null
        : null;
    } else if (row.operation.resourceType === "subscription") {
      const subscription = subscriptionById.get(row.operation.resourceId);
      externalCustomerId = subscription
        ? externalByApplicationCustomer.get(subscription.applicationCustomerId) ?? null
        : null;
    }
    logs.push({
      id: `operation:${row.operation.id}`,
      source: "billing_operation",
      level:
        row.operation.status === "failed"
          ? "error"
          : row.operation.status === "needs_reconciliation"
            ? "warning"
            : "info",
      message: `${row.operation.type} attempt ${row.operation.attemptNumber}`,
      status: row.operation.status,
      providerConnectionId: row.operation.providerConnectionId,
      provider: row.provider,
      externalCustomerId,
      orderId,
      createdAt: row.operation.createdAt,
    });
  }

  const providerIds = Array.from(
    new Set(deliveryRows.map((delivery) => delivery.providerConnectionId).filter(Boolean)),
  ) as string[];
  const providerNames = new Map<string, string>();
  if (providerIds.length > 0) {
    const providers = await db
      .select({ id: providerConnections.id, provider: providerConnections.provider })
      .from(providerConnections)
      .where(eq(providerConnections.applicationId, applicationId));
    for (const provider of providers) providerNames.set(provider.id, provider.provider);
  }
  for (const delivery of deliveryRows) {
    logs.push({
      id: `delivery:${delivery.id}`,
      source: "developer_webhook",
      level: delivery.status === "failed" ? "error" : "info",
      message: `${delivery.eventType} → ${delivery.endpointName ?? "webhook endpoint"}`,
      status: delivery.status,
      providerConnectionId: delivery.providerConnectionId,
      provider: delivery.providerConnectionId
        ? providerNames.get(delivery.providerConnectionId) ?? null
        : null,
      externalCustomerId: delivery.externalCustomerId,
      orderId: delivery.orderId,
      createdAt: delivery.createdAt,
    });
  }

  return logs
    .filter((log) => {
      if (
        filters.provider &&
        log.providerConnectionId !== filters.provider &&
        log.provider !== filters.provider
      ) {
        return false;
      }
      if (filters.customer && log.externalCustomerId !== filters.customer) return false;
      if (filters.order && log.orderId !== filters.order) return false;
      if (filters.status && log.status !== filters.status) return false;
      if (filters.type && log.source !== filters.type) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, Math.min(Math.max(filters.limit ?? 100, 1), 200));
}

export async function countFailedDeveloperWebhookDeliveries(
  applicationId: string,
  environment: ConsoleEnvironment,
) {
  const db = getDb();
  const rows = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.applicationId, applicationId),
        eq(webhookDeliveries.mode, environment),
        eq(webhookDeliveries.status, "failed"),
      ),
    );
  return rows.length;
}
