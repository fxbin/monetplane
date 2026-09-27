import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { POST as webhookPOST } from "../../src/app/api/webhooks/[connectionId]/route";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { createPrice, createProduct } from "../../src/modules/catalog/service";
import { createCommerceCheckout } from "../../src/modules/commerce/checkout";
import {
  InvalidNormalizedCommerceEventError,
  processProviderWebhook,
} from "../../src/modules/commerce/webhook";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import {
  mockProviderAdapter,
  signMockWebhookPayload,
} from "../../src/modules/providers/adapters/mock";
import { registerProviderAdapter } from "../../src/modules/providers/registry";
import { createProviderConnection } from "../../src/modules/providers/service";
import {
  createWebhookEndpoint,
  listWebhookDeliveries,
} from "../../src/modules/webhooks/service";

/**
 * Webhook retry policy (audit M4 + PR9): the route must distinguish
 * permanent validation failures (422) from transient ones (503 — the
 * provider's redelivery is the retry path), and must heal a missed
 * developer-event fan-out when a redelivery replays an already-committed
 * event.
 *
 * The processor is wrapped so individual tests can inject failures without
 * losing the real implementation (the fan-out heal test uses the real one).
 */
const processorState = vi.hoisted(() => ({
  override: null as
    | ((...args: Parameters<typeof processProviderWebhook>) => Promise<unknown>)
    | null,
}));

vi.mock("../../src/modules/commerce/webhook", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/modules/commerce/webhook")>();
  return {
    ...actual,
    processProviderWebhook: async (
      ...args: Parameters<typeof actual.processProviderWebhook>
    ) => {
      if (processorState.override) return processorState.override(...args);
      return actual.processProviderWebhook(...args);
    },
  };
});

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(() => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  registerProviderAdapter(mockProviderAdapter);
  processorState.override = null;
});

afterEach(() => {
  processorState.override = null;
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

async function seed() {
  const slug = `retry-${Math.random().toString(36).slice(2, 8)}`;
  const app = await createApplication({ slug, name: slug }, db);
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1", email: "r@test" },
    db,
  );
  const product = await createProduct(
    { applicationId: app.id, key: "pro", name: "Pro" },
    db,
  );
  const price = await createPrice(
    {
      applicationId: app.id,
      productId: product.id,
      key: "one-time",
      currency: "USD",
      amountMinor: 2900,
      billingType: "one_time",
    },
    db,
  );
  const connection = await createProviderConnection(
    {
      applicationId: app.id,
      provider: "mock",
      name: "primary",
      mode: "test",
      credentials: { webhookSecret: `${slug}-secret` },
    },
    db,
  );
  const { registerCallbackOrigin } = await import(
    "../../src/modules/applications/service"
  );
  await registerCallbackOrigin(app.id, "https://product.test/success", db);
  await registerCallbackOrigin(app.id, "https://product.test/cancel", db);
  const checkout = await createCommerceCheckout(
    app.id,
    {
      externalCustomerId: "user-1",
      items: [{ priceId: price.id, quantity: 1 }],
      successUrl: "https://product.test/success",
      cancelUrl: "https://product.test/cancel",
    },
    db,
  );
  return { app, customer, checkout, connection };
}

function signedBody(
  fixture: Awaited<ReturnType<typeof seed>>,
  eventId: string,
): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify({
    id: eventId,
    type: "payment.succeeded",
    occurred_at: new Date().toISOString(),
    data: {
      provider_payment_id: `pay_${eventId}`,
      monetplane_order_id: fixture.checkout.orderId,
      monetplane_customer_id: fixture.customer.customerId,
      amount_minor: 2900,
      currency: "USD",
    },
  });
  return {
    rawBody,
    headers: {
      "x-monetplane-mock-signature": signMockWebhookPayload(
        rawBody,
        `${fixture.app.slug}-secret`,
      ),
    },
  };
}

function postWebhook(
  connectionId: string,
  body: string,
  headers: Record<string, string>,
) {
  return webhookPOST(
    new Request(`https://console.test/api/webhooks/${connectionId}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    }),
    { params: Promise.resolve({ connectionId }) },
  );
}

describe("webhook retry policy (PR9)", () => {
  it("answers 503 processed:false on a transient processing failure", async () => {
    const f = await seed();
    const { rawBody, headers } = signedBody(f, "evt_transient_1");
    processorState.override = () => {
      throw new Error("connection reset by peer");
    };

    const response = await postWebhook(f.connection.id, rawBody, headers);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      received: true,
      processed: false,
    });
  });

  it("answers 422 permanent:true on an invalid normalized event", async () => {
    const f = await seed();
    const { rawBody, headers } = signedBody(f, "evt_permanent_1");
    processorState.override = () =>
      Promise.reject(
        new InvalidNormalizedCommerceEventError(
          "currency mismatch: event currency EUR does not match recorded currency USD",
        ),
      );

    const response = await postWebhook(f.connection.id, rawBody, headers);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      received: true,
      processed: false,
      permanent: true,
      error: expect.stringContaining("currency mismatch"),
    });
  });

  it("heals a missed fan-out when a redelivery replays a committed event", async () => {
    const f = await seed();
    const deliveries: Array<{ eventId: string }> = [];
    const receiver = await startReceiver((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        deliveries.push({ eventId: JSON.parse(body).id });
        res.statusCode = 204;
        res.end();
      });
    });
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );

    // First attempt commits the commerce effect but "crashes" before the
    // route could publish the developer event (no publish happens here).
    const { rawBody, headers } = signedBody(f, "evt_heal_1");
    const direct = await processProviderWebhook(
      f.app.id,
      f.connection.id,
      { rawBody, headers },
      db,
    );
    expect(direct).toMatchObject({ status: "processed", duplicate: false });

    // The provider redelivers; the route replays (duplicate) and must heal
    // the missed fan-out.
    const first = await postWebhook(f.connection.id, rawBody, headers);
    expect(first.status).toBe(200);

    // A second redelivery must not duplicate the developer delivery.
    await postWebhook(f.connection.id, rawBody, headers);

    expect(deliveries).toHaveLength(1);
    const rows = await listWebhookDeliveries(f.app.id, "test", {}, db);
    expect(rows.filter((row) => row.status === "succeeded")).toHaveLength(1);
  });

  it("still publishes on the first successful attempt (non-duplicate)", async () => {
    const f = await seed();
    const deliveries: string[] = [];
    const receiver = await startReceiver((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        deliveries.push(JSON.parse(body).id);
        res.statusCode = 204;
        res.end();
      });
    });
    await createWebhookEndpoint(
      f.app.id,
      "test",
      {
        name: "receiver",
        url: receiver.url,
        eventTypes: ["payment.succeeded"],
      },
      db,
    );

    const { rawBody, headers } = signedBody(f, "evt_first_1");
    const response = await postWebhook(f.connection.id, rawBody, headers);
    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(1);
  });
});
