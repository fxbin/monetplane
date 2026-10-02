import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as sweepPOST } from "../../src/app/api/cron/webhook-deliveries/route";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { webhookDeliveries } from "../../src/modules/webhooks/schema";
import {
  createWebhookEndpoint,
  sweepPendingWebhookDeliveries,
} from "../../src/modules/webhooks/service";

/**
 * Pending-delivery sweeper (#126): a delivery row inserted but never
 * attempted (process crash mid-dispatch) must be re-delivered by the
 * sweeper under an exponential backoff with an atomic claim; fresh rows are
 * left alone; max-attempt rows park as failed; concurrent sweeps never
 * double-deliver.
 *
 * Fixtures live inside each test (the integration setup truncates the app
 * graph before every test).
 */
const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  await getSqlClient().end({ timeout: 1 });
});

async function startReceiver(
  handler: RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/monetplane`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function seedPendingDelivery(input: {
  endpointId: string;
  applicationId: string;
  createdAt: Date;
  lastAttemptAt: Date | null;
  attemptCount: number;
}) {
  const eventId = `dev_wh_sweep_${Math.random().toString(36).slice(2, 10)}`;
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      id: `whd_${eventId}`,
      endpointId: input.endpointId,
      applicationId: input.applicationId,
      mode: "test",
      eventId,
      eventType: "payment.succeeded",
      payload: {
        id: eventId,
        version: 1,
        type: "payment.succeeded",
        data: {},
      },
      status: "pending",
      attemptCount: input.attemptCount,
      createdAt: input.createdAt,
      lastAttemptAt: input.lastAttemptAt,
    })
    .returning();
  if (!row) throw new Error("failed to seed delivery row");
  return row;
}

async function fixtureApp() {
  return createApplication(
    {
      slug: `sweep-${Math.random().toString(36).slice(2, 8)}`,
      name: "Sweep",
    },
    db,
  );
}

describe("pending webhook delivery sweeper (#126)", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it("delivers a stale never-attempted pending row", async () => {
    const app = await fixtureApp();
    let received = 0;
    const receiver = await startReceiver((_req, res) => {
      received += 1;
      res.statusCode = 204;
      res.end();
    });
    closers.push(receiver.close);
    const endpoint = await createWebhookEndpoint(
      app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );
    const seeded = await seedPendingDelivery({
      endpointId: endpoint.id,
      applicationId: app.id,
      createdAt: new Date(Date.now() - 5 * 60_000),
      lastAttemptAt: null,
      attemptCount: 0,
    });

    const result = await sweepPendingWebhookDeliveries({}, db);
    expect(result.delivered).toBeGreaterThanOrEqual(1);

    const [after] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, seeded.id));
    expect(after?.status).toBe("succeeded");
    expect(after?.attemptCount).toBe(1);
    expect(received).toBe(1);
  });

  it("leaves fresh pending rows alone (crash grace window)", async () => {
    const app = await fixtureApp();
    const endpoint = await createWebhookEndpoint(
      app.id,
      "test",
      { name: "receiver", url: "http://127.0.0.1:9/never", eventTypes: ["*"] },
      db,
    );
    const seeded = await seedPendingDelivery({
      endpointId: endpoint.id,
      applicationId: app.id,
      createdAt: new Date(),
      lastAttemptAt: null,
      attemptCount: 0,
    });

    const result = await sweepPendingWebhookDeliveries({}, db);
    expect(result.delivered).toBe(0);

    const [after] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, seeded.id));
    expect(after?.status).toBe("pending");
    expect(after?.attemptCount).toBe(0);
  });

  it("honors the exponential backoff keyed on attempt count", async () => {
    const app = await fixtureApp();
    const endpoint = await createWebhookEndpoint(
      app.id,
      "test",
      { name: "receiver", url: "http://127.0.0.1:9/never", eventTypes: ["*"] },
      db,
    );
    // attemptCount=1 -> backoff 2 minutes; last attempt 30s ago -> not due.
    const notDue = await seedPendingDelivery({
      endpointId: endpoint.id,
      applicationId: app.id,
      createdAt: new Date(Date.now() - 10 * 60_000),
      lastAttemptAt: new Date(Date.now() - 30_000),
      attemptCount: 1,
    });
    const result = await sweepPendingWebhookDeliveries({}, db);
    expect(result.delivered).toBe(0);
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, notDue.id));
    expect(row?.attemptCount).toBe(1);
  });

  it("parks a pending row that exceeded the max attempts as failed", async () => {
    const app = await fixtureApp();
    const endpoint = await createWebhookEndpoint(
      app.id,
      "test",
      { name: "receiver", url: "http://127.0.0.1:9/never", eventTypes: ["*"] },
      db,
    );
    const seeded = await seedPendingDelivery({
      endpointId: endpoint.id,
      applicationId: app.id,
      createdAt: new Date(Date.now() - 60 * 60_000),
      lastAttemptAt: new Date(Date.now() - 2 * 60 * 60_000),
      attemptCount: 8,
    });

    const result = await sweepPendingWebhookDeliveries({}, db);
    expect(result.parked).toBeGreaterThanOrEqual(1);

    const [after] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, seeded.id));
    expect(after?.status).toBe("failed");
    expect(after?.errorMessage).toContain("exceeded");
  });

  it("concurrent sweeps deliver a stale row exactly once", async () => {
    const app = await fixtureApp();
    let received = 0;
    const receiver = await startReceiver((_req, res) => {
      received += 1;
      res.statusCode = 204;
      res.end();
    });
    closers.push(receiver.close);
    const endpoint = await createWebhookEndpoint(
      app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );
    const seeded = await seedPendingDelivery({
      endpointId: endpoint.id,
      applicationId: app.id,
      createdAt: new Date(Date.now() - 5 * 60_000),
      lastAttemptAt: null,
      attemptCount: 0,
    });

    await Promise.allSettled([
      sweepPendingWebhookDeliveries({}, db),
      sweepPendingWebhookDeliveries({}, db),
    ]);

    const [after] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, seeded.id));
    expect(after?.status).toBe("succeeded");
    expect(after?.attemptCount).toBe(1);
    expect(received).toBe(1);
  });

  it("cron route fails closed without CRON_SECRET and sweeps when authorized", async () => {
    const previous = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;

    const unauthorized = await sweepPOST(
      new Request("https://console.test/api/cron/webhook-deliveries"),
    );
    expect(unauthorized.status).toBe(401);

    process.env.CRON_SECRET = "cron-test-secret";
    try {
      const authorized = await sweepPOST(
        new Request("https://console.test/api/cron/webhook-deliveries", {
          headers: { authorization: "Bearer cron-test-secret" },
        }),
      );
      expect(authorized.status).toBe(200);
      await expect(authorized.json()).resolves.toMatchObject({
        swept: expect.any(Number),
        delivered: expect.any(Number),
        parked: expect.any(Number),
      });

      const wrongSecret = await sweepPOST(
        new Request("https://console.test/api/cron/webhook-deliveries", {
          headers: { authorization: "Bearer wrong" },
        }),
      );
      expect(wrongSecret.status).toBe(401);
    } finally {
      if (previous === undefined) {
        delete process.env.CRON_SECRET;
      } else {
        process.env.CRON_SECRET = previous;
      }
    }
  });
});
