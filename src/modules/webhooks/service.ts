import { randomUUID } from "node:crypto";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import {
  decryptWebhookSecret,
  generateWebhookSecret,
  signWebhookPayload,
} from "./crypto";
import { webhookDeliveries, webhookEndpoints } from "./schema";

export type WebhookMode = "test" | "live";

export type CreateWebhookEndpointInput = {
  name: string;
  url: string;
  eventTypes?: string[];
};

export type WebhookDeliveryFilters = {
  endpointId?: string;
  status?: "pending" | "succeeded" | "failed";
  providerConnectionId?: string;
  externalCustomerId?: string;
  orderId?: string;
  limit?: number;
};

export type DispatchWebhookEventInput = {
  applicationId: string;
  mode: WebhookMode;
  eventId?: string;
  eventType: string;
  providerConnectionId?: string | null;
  externalCustomerId?: string | null;
  orderId?: string | null;
  data: Record<string, unknown>;
};

export class WebhookEndpointNotFoundError extends Error {
  constructor(message = "Webhook endpoint not found") {
    super(message);
    this.name = "WebhookEndpointNotFoundError";
  }
}

export class WebhookDeliveryNotFoundError extends Error {
  constructor(message = "Webhook delivery not found") {
    super(message);
    this.name = "WebhookDeliveryNotFoundError";
  }
}

function normalizeWebhookName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Webhook endpoint name is required");
  if (name.length > 80) throw new Error("Webhook endpoint name is too long");
  return name;
}

export function normalizeWebhookUrl(value: string, mode: WebhookMode): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Webhook endpoint must be a valid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Webhook endpoint must use http or https");
  }
  if (mode === "live" && url.protocol !== "https:") {
    throw new Error("Production webhook endpoints must use https");
  }
  if (url.username || url.password) {
    throw new Error("Webhook endpoint URL must not contain credentials");
  }
  if (url.hash) {
    throw new Error("Webhook endpoint URL must not contain a fragment");
  }
  if (url.toString().length > 2048) {
    throw new Error("Webhook endpoint URL is too long");
  }

  return url.toString();
}

export function normalizeWebhookEventTypes(values?: string[]): string[] {
  const candidates = values?.length ? values : ["*"];
  const normalized = Array.from(
    new Set(
      candidates.map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  );
  if (normalized.length === 0) return ["*"];
  if (normalized.length > 50) {
    throw new Error(
      "A webhook endpoint can subscribe to at most 50 event types",
    );
  }
  for (const value of normalized) {
    if (value !== "*" && !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
      throw new Error(`Invalid webhook event type: ${value}`);
    }
  }
  return normalized;
}

function endpointView(endpoint: typeof webhookEndpoints.$inferSelect) {
  return {
    id: endpoint.id,
    applicationId: endpoint.applicationId,
    mode: endpoint.mode as WebhookMode,
    name: endpoint.name,
    url: endpoint.url,
    secretPrefix: endpoint.secretPrefix,
    eventTypes: endpoint.eventTypes,
    status: endpoint.status,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    disabledAt: endpoint.disabledAt,
  };
}

function deliveryView(
  delivery: typeof webhookDeliveries.$inferSelect,
  endpointName?: string,
) {
  return {
    id: delivery.id,
    endpointId: delivery.endpointId,
    endpointName: endpointName ?? null,
    applicationId: delivery.applicationId,
    mode: delivery.mode as WebhookMode,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    providerConnectionId: delivery.providerConnectionId,
    externalCustomerId: delivery.externalCustomerId,
    orderId: delivery.orderId,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    responseStatus: delivery.responseStatus,
    errorMessage: delivery.errorMessage,
    createdAt: delivery.createdAt,
    lastAttemptAt: delivery.lastAttemptAt,
    deliveredAt: delivery.deliveredAt,
  };
}

export async function createWebhookEndpoint(
  applicationId: string,
  mode: WebhookMode,
  input: CreateWebhookEndpointInput,
  db: Database = getDb(),
) {
  const generated = generateWebhookSecret();
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      id: `whep_${randomUUID()}`,
      applicationId,
      mode,
      name: normalizeWebhookName(input.name),
      url: normalizeWebhookUrl(input.url, mode),
      secretCiphertext: generated.secretCiphertext,
      secretPrefix: generated.secretPrefix,
      eventTypes: normalizeWebhookEventTypes(input.eventTypes),
    })
    .returning();

  if (!endpoint) throw new Error("Failed to create webhook endpoint");
  return { ...endpointView(endpoint), secret: generated.secret };
}

export async function listWebhookEndpoints(
  applicationId: string,
  mode: WebhookMode,
  db: Database = getDb(),
) {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.applicationId, applicationId),
        eq(webhookEndpoints.mode, mode),
      ),
    )
    .orderBy(desc(webhookEndpoints.createdAt));
  return rows.map(endpointView);
}

async function getActiveEndpoint(
  applicationId: string,
  mode: WebhookMode,
  endpointId: string,
  db: Database,
) {
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.applicationId, applicationId),
        eq(webhookEndpoints.mode, mode),
        eq(webhookEndpoints.status, "active"),
      ),
    )
    .limit(1);
  if (!endpoint) throw new WebhookEndpointNotFoundError();
  return endpoint;
}

export async function rotateWebhookEndpointSecret(
  applicationId: string,
  mode: WebhookMode,
  endpointId: string,
  db: Database = getDb(),
) {
  await getActiveEndpoint(applicationId, mode, endpointId, db);
  const generated = generateWebhookSecret();
  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({
      secretCiphertext: generated.secretCiphertext,
      secretPrefix: generated.secretPrefix,
      updatedAt: new Date(),
    })
    .where(eq(webhookEndpoints.id, endpointId))
    .returning();
  if (!endpoint) throw new WebhookEndpointNotFoundError();
  return { ...endpointView(endpoint), secret: generated.secret };
}

export async function disableWebhookEndpoint(
  applicationId: string,
  mode: WebhookMode,
  endpointId: string,
  db: Database = getDb(),
) {
  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({ status: "disabled", disabledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.applicationId, applicationId),
        eq(webhookEndpoints.mode, mode),
        eq(webhookEndpoints.status, "active"),
      ),
    )
    .returning();
  if (!endpoint) throw new WebhookEndpointNotFoundError();
  return endpointView(endpoint);
}

export async function listWebhookDeliveries(
  applicationId: string,
  mode: WebhookMode,
  filters: WebhookDeliveryFilters = {},
  db: Database = getDb(),
) {
  const conditions: SQL[] = [
    eq(webhookDeliveries.applicationId, applicationId),
    eq(webhookDeliveries.mode, mode),
  ];
  if (filters.endpointId) {
    conditions.push(eq(webhookDeliveries.endpointId, filters.endpointId));
  }
  if (filters.status) {
    conditions.push(eq(webhookDeliveries.status, filters.status));
  }
  if (filters.providerConnectionId) {
    conditions.push(
      eq(webhookDeliveries.providerConnectionId, filters.providerConnectionId),
    );
  }
  if (filters.externalCustomerId) {
    conditions.push(
      eq(webhookDeliveries.externalCustomerId, filters.externalCustomerId),
    );
  }
  if (filters.orderId) {
    conditions.push(eq(webhookDeliveries.orderId, filters.orderId));
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      delivery: webhookDeliveries,
      endpointName: webhookEndpoints.name,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookEndpoints.id, webhookDeliveries.endpointId),
    )
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);

  return rows.map((row) => deliveryView(row.delivery, row.endpointName));
}

export async function deliverWebhookDelivery(
  applicationId: string,
  mode: WebhookMode,
  deliveryId: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  db: Database = getDb(),
) {
  const [row] = await db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookEndpoints.id, webhookDeliveries.endpointId),
    )
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.applicationId, applicationId),
        eq(webhookDeliveries.mode, mode),
        eq(webhookEndpoints.status, "active"),
      ),
    )
    .limit(1);
  if (!row) throw new WebhookDeliveryNotFoundError();

  const now = new Date();
  const attemptCount = row.delivery.attemptCount + 1;
  await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attemptCount,
      responseStatus: null,
      errorMessage: null,
      lastAttemptAt: now,
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  const secret = decryptWebhookSecret(row.endpoint.secretCiphertext);
  const rawBody = JSON.stringify(row.delivery.payload);
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const signature = signWebhookPayload(
    secret,
    row.delivery.eventId,
    timestamp,
    rawBody,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const response = await fetchImpl(row.endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "MonetPlane-Webhooks/1.0",
        "x-monetplane-event-id": row.delivery.eventId,
        "x-monetplane-timestamp": timestamp,
        "x-monetplane-signature": signature,
      },
      body: rawBody,
      signal: controller.signal,
    });

    const succeeded = response.ok;
    const [updated] = await db
      .update(webhookDeliveries)
      .set({
        status: succeeded ? "succeeded" : "failed",
        responseStatus: response.status,
        errorMessage: succeeded
          ? null
          : `Endpoint returned HTTP ${response.status}`,
        deliveredAt: succeeded ? new Date() : null,
      })
      .where(eq(webhookDeliveries.id, deliveryId))
      .returning();
    if (!updated) throw new WebhookDeliveryNotFoundError();
    return deliveryView(updated, row.endpoint.name);
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 1000) : "Delivery failed";
    const [updated] = await db
      .update(webhookDeliveries)
      .set({ status: "failed", responseStatus: null, errorMessage: message })
      .where(eq(webhookDeliveries.id, deliveryId))
      .returning();
    if (!updated) throw new WebhookDeliveryNotFoundError();
    return deliveryView(updated, row.endpoint.name);
  } finally {
    clearTimeout(timer);
  }
}

export async function createTestWebhookDelivery(
  applicationId: string,
  mode: WebhookMode,
  endpointId: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  db: Database = getDb(),
) {
  const endpoint = await getActiveEndpoint(applicationId, mode, endpointId, db);
  const eventId = `evt_test_${randomUUID()}`;
  const payload = {
    id: eventId,
    type: "system.test",
    createdAt: new Date().toISOString(),
    data: {
      applicationId,
      environment: mode === "test" ? "sandbox" : "production",
      message: "MonetPlane webhook test delivery",
    },
  };
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      id: `whd_${randomUUID()}`,
      endpointId: endpoint.id,
      applicationId,
      mode,
      eventId,
      eventType: "system.test",
      payload,
    })
    .returning();
  if (!delivery) throw new Error("Failed to create webhook test delivery");
  return deliverWebhookDelivery(applicationId, mode, delivery.id, options, db);
}

export async function retryWebhookDelivery(
  applicationId: string,
  mode: WebhookMode,
  deliveryId: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  db: Database = getDb(),
) {
  const [delivery] = await db
    .select({ status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.applicationId, applicationId),
        eq(webhookDeliveries.mode, mode),
      ),
    )
    .limit(1);
  if (!delivery) throw new WebhookDeliveryNotFoundError();
  if (delivery.status !== "failed") {
    throw new Error("Only failed webhook deliveries can be retried");
  }
  return deliverWebhookDelivery(applicationId, mode, deliveryId, options, db);
}

function endpointAccepts(endpointEventTypes: string[], eventType: string) {
  return (
    endpointEventTypes.includes("*") || endpointEventTypes.includes(eventType)
  );
}

export async function dispatchWebhookEvent(
  input: DispatchWebhookEventInput,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  db: Database = getDb(),
) {
  const eventType = input.eventType.trim().toLowerCase();
  if (!eventType) throw new Error("Webhook event type is required");
  const eventId = input.eventId?.trim() || `evt_${randomUUID()}`;
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.applicationId, input.applicationId),
        eq(webhookEndpoints.mode, input.mode),
        eq(webhookEndpoints.status, "active"),
      ),
    );
  const matching = endpoints.filter((endpoint) =>
    endpointAccepts(endpoint.eventTypes, eventType),
  );
  const payload = {
    id: eventId,
    version: 1,
    type: eventType,
    createdAt: new Date().toISOString(),
    data: input.data,
  };

  const deliveryIds: string[] = [];
  for (const endpoint of matching) {
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        id: `whd_${randomUUID()}`,
        endpointId: endpoint.id,
        applicationId: input.applicationId,
        mode: input.mode,
        eventId,
        eventType,
        providerConnectionId: input.providerConnectionId ?? null,
        externalCustomerId: input.externalCustomerId ?? null,
        orderId: input.orderId ?? null,
        payload,
      })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });
    if (delivery) deliveryIds.push(delivery.id);
  }

  const settled = await Promise.allSettled(
    deliveryIds.map((deliveryId) =>
      deliverWebhookDelivery(
        input.applicationId,
        input.mode,
        deliveryId,
        options,
        db,
      ),
    ),
  );
  return {
    eventId,
    matchedEndpoints: matching.length,
    attemptedDeliveries: deliveryIds.length,
    succeeded: settled.filter(
      (result) =>
        result.status === "fulfilled" && result.value.status === "succeeded",
    ).length,
  };
}
