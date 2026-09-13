import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import {
  createProviderConnection,
  getProviderConnection,
  loadProviderConnectionContext,
  ProviderConnectionNotFoundError,
  revokeProviderConnection,
  updateProviderConnection,
} from "../../src/modules/providers/service";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  await db.delete(applications);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  await getSqlClient().end({ timeout: 1 });
});

describe("provider connection management", () => {
  it("renames a connection without replacing its write-only credentials", async () => {
    const app = await createApplication(
      { slug: "provider-manage-name", name: "Provider Manage Name" },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "creem",
        name: "Creem Sandbox",
        mode: "test",
        credentials: {
          apiKey: "old-api-key",
          webhookSecret: "old-webhook-secret",
        },
      },
      db,
    );

    const updated = await updateProviderConnection(
      app.id,
      connection.id,
      { name: "Primary Sandbox" },
      db,
    );
    expect(updated?.name).toBe("Primary Sandbox");
    expect(updated).not.toHaveProperty("encryptedCredentials");

    const runtime = await loadProviderConnectionContext(
      app.id,
      connection.id,
      db,
    );
    expect(runtime.credentials).toEqual({
      apiKey: "old-api-key",
      webhookSecret: "old-webhook-secret",
    });
  });

  it("replaces the complete encrypted credential envelope without exposing plaintext in the view", async () => {
    const app = await createApplication(
      { slug: "provider-manage-secret", name: "Provider Manage Secret" },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "creem",
        name: "Creem Sandbox",
        mode: "test",
        credentials: {
          apiKey: "old-api-key",
          webhookSecret: "old-webhook-secret",
        },
      },
      db,
    );

    const updated = await updateProviderConnection(
      app.id,
      connection.id,
      {
        credentials: {
          apiKey: "new-api-key",
          webhookSecret: "new-webhook-secret",
        },
      },
      db,
    );
    expect(updated?.credentialConfigured).toBe(true);
    expect(updated).not.toHaveProperty("encryptedCredentials");

    const runtime = await loadProviderConnectionContext(
      app.id,
      connection.id,
      db,
    );
    expect(runtime.credentials).toEqual({
      apiKey: "new-api-key",
      webhookSecret: "new-webhook-secret",
    });
  });

  it("keeps revoked connections visible but prevents further runtime or configuration use", async () => {
    const app = await createApplication(
      { slug: "provider-manage-revoke", name: "Provider Manage Revoke" },
      db,
    );
    const connection = await createProviderConnection(
      {
        applicationId: app.id,
        provider: "creem",
        name: "Creem Sandbox",
        mode: "test",
        credentials: {
          apiKey: "api-key",
          webhookSecret: "webhook-secret",
        },
      },
      db,
    );

    expect(await revokeProviderConnection(app.id, connection.id, db)).toBe(
      true,
    );

    const historical = await getProviderConnection(app.id, connection.id, db);
    expect(historical?.status).toBe("revoked");
    expect(historical?.revokedAt).toBeInstanceOf(Date);

    const updated = await updateProviderConnection(
      app.id,
      connection.id,
      { name: "Should not update" },
      db,
    );
    expect(updated).toBeNull();

    await expect(
      loadProviderConnectionContext(app.id, connection.id, db),
    ).rejects.toBeInstanceOf(ProviderConnectionNotFoundError);
  });
});
