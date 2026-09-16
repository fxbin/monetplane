import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  authenticateApplicationCredential,
  createApplication,
} from "../../src/modules/applications/service";
import {
  createTestWebhookDelivery,
  createWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  retryWebhookDelivery,
  rotateWebhookEndpointSecret,
} from "../../src/modules/webhooks/service";
import {
  createDeveloperApiKey,
  getDeveloperHealth,
  revokeDeveloperApiKey,
  rotateDeveloperApiKey,
} from "../../src/server/control-plane/developer";

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

describe("developer tools integration", () => {
  it("keeps webhook signing secrets write-only and signs a real test delivery", async () => {
    let receivedBody = "";
    let receivedSignature = "";
    const receiver = await startReceiver((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        receivedSignature = String(
          request.headers["x-monetplane-signature"] ?? "",
        );
        response.statusCode = 204;
        response.end();
      });
    });

    try {
      const app = await createApplication(
        { slug: "developer-webhook", name: "Developer Webhook" },
        db,
      );
      const created = await createWebhookEndpoint(
        app.id,
        "test",
        { name: "Backend", url: receiver.url, eventTypes: ["*"] },
        db,
      );
      expect(created.secret).toMatch(/^mp_whsec_/);

      const endpoints = await listWebhookEndpoints(app.id, "test", db);
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]).not.toHaveProperty("secret");
      expect(endpoints[0]).not.toHaveProperty("secretCiphertext");

      const delivery = await createTestWebhookDelivery(
        app.id,
        "test",
        created.id,
        {},
        db,
      );
      expect(delivery).toMatchObject({
        status: "succeeded",
        responseStatus: 204,
        attemptCount: 1,
        eventType: "system.test",
      });
      expect(receivedSignature).toMatch(/^v1=[a-f0-9]{64}$/);
      expect(JSON.parse(receivedBody)).toMatchObject({ type: "system.test" });

      const rotated = await rotateWebhookEndpointSecret(
        app.id,
        "test",
        created.id,
        db,
      );
      expect(rotated.secret).toMatch(/^mp_whsec_/);
      expect(rotated.secret).not.toBe(created.secret);
    } finally {
      await receiver.close();
    }
  });

  it("records a failed delivery and retries the same event successfully", async () => {
    let attempts = 0;
    const receiver = await startReceiver((_request, response) => {
      attempts += 1;
      response.statusCode = attempts === 1 ? 503 : 204;
      response.end();
    });

    try {
      const app = await createApplication(
        { slug: "developer-retry", name: "Developer Retry" },
        db,
      );
      const endpoint = await createWebhookEndpoint(
        app.id,
        "test",
        { name: "Retry receiver", url: receiver.url },
        db,
      );
      const failed = await createTestWebhookDelivery(
        app.id,
        "test",
        endpoint.id,
        {},
        db,
      );
      expect(failed).toMatchObject({
        status: "failed",
        responseStatus: 503,
        attemptCount: 1,
      });

      const retried = await retryWebhookDelivery(
        app.id,
        "test",
        failed.id,
        {},
        db,
      );
      expect(retried).toMatchObject({
        id: failed.id,
        eventId: failed.eventId,
        status: "succeeded",
        responseStatus: 204,
        attemptCount: 2,
      });
      const deliveries = await listWebhookDeliveries(app.id, "test", {}, db);
      expect(deliveries).toHaveLength(1);
    } finally {
      await receiver.close();
    }
  });

  it("rotates an API key without revoking the previous secret before deployment", async () => {
    const app = await createApplication(
      { slug: "developer-keys", name: "Developer Keys" },
      db,
    );
    const original = await createDeveloperApiKey(app.id, "Backend");
    const replacement = await rotateDeveloperApiKey(app.id, original.id);

    expect(replacement.secret).toMatch(/^mp_app_/);
    expect(replacement.previousKeyStillActive).toBe(true);
    await expect(
      authenticateApplicationCredential(original.secret, db),
    ).resolves.toMatchObject({
      id: app.id,
    });
    await expect(
      authenticateApplicationCredential(replacement.secret, db),
    ).resolves.toMatchObject({
      id: app.id,
    });

    await revokeDeveloperApiKey(app.id, original.id);
    await expect(
      authenticateApplicationCredential(original.secret, db),
    ).resolves.toBeNull();
    await expect(
      authenticateApplicationCredential(replacement.secret, db),
    ).resolves.toMatchObject({
      id: app.id,
    });
  });

  it("summarizes observed API and webhook integration health", async () => {
    const receiver = await startReceiver((_request, response) => {
      response.statusCode = 204;
      response.end();
    });

    try {
      const app = await createApplication(
        { slug: "developer-health", name: "Developer Health" },
        db,
      );
      const key = await createDeveloperApiKey(app.id, "Backend");
      await authenticateApplicationCredential(key.secret, db);
      const endpoint = await createWebhookEndpoint(
        app.id,
        "test",
        { name: "Health receiver", url: receiver.url },
        db,
      );
      await createTestWebhookDelivery(app.id, "test", endpoint.id, {}, db);

      await expect(getDeveloperHealth(app.id, "test")).resolves.toEqual({
        apiKeyCreated: true,
        apiRequestReceived: true,
        webhookConfigured: true,
        webhookDelivered: true,
        firstProviderEventReceived: false,
        firstPaymentReceived: false,
      });
    } finally {
      await receiver.close();
    }
  });
});
