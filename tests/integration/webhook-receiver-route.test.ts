import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { POST as receiveWebhook } from "../../src/app/api/webhooks/[connectionId]/route";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
import { registerProviderAdapter } from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";

const db = getDb();

process.env.MONETPLANE_ENCRYPTION_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
registerProviderAdapter(mockProviderAdapter);

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  await getSqlClient().end({ timeout: 1 });
});

function request(url: string, body: string, headers: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("inbound provider webhook receiver (#95)", () => {
  it("resolves the application from the connection without custom headers", async () => {
    const slug = `receiver-${Math.random().toString(36).slice(2, 8)}`;
    const app = await createApplication({ slug, name: slug }, db);
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "mock",
        name: "receiver",
        mode: "test",
        credentials: { webhookSecret: `${slug}-secret` },
      },
      db,
    );

    const rawBody = JSON.stringify({
      id: "evt_receiver_1",
      type: "payment.succeeded",
      occurred_at: new Date().toISOString(),
      data: {
        provider_payment_id: "pay_receiver_1",
        amount_minor: 1900,
        currency: "USD",
      },
    });
    // No x-monetplane-application header — providers never send it.
    const response = await receiveWebhook(
      request("http://localhost/api/webhooks/x", rawBody, {
        "x-monetplane-mock-signature": signMockWebhookPayload(
          rawBody,
          `${slug}-secret`,
        ),
      }),
      { params: Promise.resolve({ connectionId: connection.id }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });

  it("fails closed with 404 for unknown connections", async () => {
    const response = await receiveWebhook(
      request("http://localhost/api/webhooks/x", "{}", {}),
      { params: Promise.resolve({ connectionId: "pconn_does_not_exist" }) },
    );
    expect(response.status).toBe(404);
  });

  it("rejects invalid signatures with 401", async () => {
    const slug = `receiver-bad-${Math.random().toString(36).slice(2, 6)}`;
    const app = await createApplication({ slug, name: slug }, db);
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "mock",
        name: "receiver",
        mode: "test",
        credentials: { webhookSecret: `${slug}-secret` },
      },
      db,
    );
    const rawBody = JSON.stringify({
      id: "evt_bad_sig",
      type: "payment.succeeded",
      occurred_at: new Date().toISOString(),
      data: {},
    });
    const response = await receiveWebhook(
      request("http://localhost/api/webhooks/x", rawBody, {
        "x-monetplane-mock-signature": "deadbeef",
      }),
      { params: Promise.resolve({ connectionId: connection.id }) },
    );
    expect(response.status).toBe(401);
  });
});
