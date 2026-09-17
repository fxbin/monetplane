import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { createApplication } from "../../src/modules/applications/service";
import { operatorAuditLog } from "../../src/modules/operations/audit-schema";
import {
  correlationIdFrom,
  listAuditEntries,
  recordAuditEntry,
  redactAuditMetadata,
} from "../../src/server/control-plane/audit";

const db = getDb();

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

describe("operator audit log (#66)", () => {
  it("records immutable, application-scoped audit entries with actor and correlation id", async () => {
    const slug = `audit-${Math.random().toString(36).slice(2, 8)}`;
    const app = await createApplication({ slug, name: slug }, db);

    const entry = await recordAuditEntry(
      {
        applicationId: app.id,
        environment: "test",
        action: "api_key.created",
        resourceType: "application_credential",
        resourceId: "cred_test_1",
        metadata: { name: "prod", secretPrefix: "mp_app_ABCD" },
        actor: { id: "admin@example.com", label: "Admin" },
        request: new Request("https://console.test/api", {
          headers: { "x-monetplane-request-id": "req_12345678" },
        }),
      },
      db,
    );

    expect(entry).toMatchObject({
      applicationId: app.id,
      environment: "test",
      actorId: "admin@example.com",
      action: "api_key.created",
      correlationId: "req_12345678",
    });
    // Secret-ish keys keep their name but never their value.
    expect(entry.metadata).toMatchObject({
      name: "prod",
      secretPrefix: "[redacted]",
    });
    expect(
      redactAuditMetadata({
        apiKeySecret: "mp_app_super",
        webhookSecret: "whsec_x",
      }),
    ).toEqual({
      apiKeySecret: "[redacted]",
      webhookSecret: "[redacted]",
    });

    // Append-only: UPDATE and DELETE fail at the database level.
    await expect(
      db
        .update(operatorAuditLog)
        .set({ action: "tampered" })
        .where(eq(operatorAuditLog.id, entry.id)),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.delete(operatorAuditLog).where(eq(operatorAuditLog.id, entry.id)),
    ).rejects.toThrow(/append-only/i);
  });

  it("deep-redacts nested secrets and truncates long values", () => {
    const redacted = redactAuditMetadata({
      name: "primary",
      providerPayload: {
        apiKey: "sk_live_abc",
        nested: { signingSecret: "x" },
      },
      note: "a".repeat(500),
    });
    // Whole credential-like containers redact wholesale (coarse but safe);
    // secret-ish leaf keys redact by value.
    expect(redacted).toEqual({
      name: "primary",
      providerPayload: {
        apiKey: "[redacted]",
        nested: { signingSecret: "[redacted]" },
      },
      note: expect.stringContaining("…"),
    });
  });

  it("scopes audit reads to the application (cross-app access fails closed)", async () => {
    const slugA = `audit-a-${Math.random().toString(36).slice(2, 6)}`;
    const slugB = `audit-b-${Math.random().toString(36).slice(2, 6)}`;
    const appA = await createApplication({ slug: slugA, name: slugA }, db);
    const appB = await createApplication({ slug: slugB, name: slugB }, db);

    await recordAuditEntry(
      {
        applicationId: appA.id,
        action: "credits.granted",
        resourceType: "credit_transaction",
        resourceId: "ctx_1",
        actor: { id: "admin" },
      },
      db,
    );

    const listA = await listAuditEntries(appA.id, {}, db);
    const listB = await listAuditEntries(appB.id, {}, db);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(0);
  });

  it("filters by action, actor, environment, and date", async () => {
    const slug = `audit-f-${Math.random().toString(36).slice(2, 6)}`;
    const app = await createApplication({ slug, name: slug }, db);
    await recordAuditEntry(
      {
        applicationId: app.id,
        environment: "live",
        action: "provider.connected",
        resourceType: "provider_connection",
        resourceId: "pconn_1",
        actor: { id: "alice" },
      },
      db,
    );
    await recordAuditEntry(
      {
        applicationId: app.id,
        environment: "test",
        action: "provider.revoked",
        resourceType: "provider_connection",
        resourceId: "pconn_2",
        actor: { id: "bob" },
      },
      db,
    );

    const live = await listAuditEntries(app.id, { environment: "live" }, db);
    expect(live.map((e) => e.action)).toEqual(["provider.connected"]);
    const byActor = await listAuditEntries(app.id, { actor: "bob" }, db);
    expect(byActor.map((e) => e.action)).toEqual(["provider.revoked"]);
    const none = await listAuditEntries(
      app.id,
      { from: new Date(Date.now() + 60_000) },
      db,
    );
    expect(none).toHaveLength(0);
  });

  it("generates safe correlation ids", () => {
    expect(correlationIdFrom(undefined)).toMatch(/^req_[0-9a-f-]{8,}$/);
    expect(correlationIdFrom(new Request("https://x.test", {}))).toMatch(
      /^req_/,
    );
    const hostile = new Request("https://x.test", {
      headers: { "x-monetplane-request-id": "bad value; drop table" },
    });
    expect(correlationIdFrom(hostile)).toMatch(/^req_/);
  });

  it("records environment-sensitive actions with the effective environment", async () => {
    const slug = `audit-e-${Math.random().toString(36).slice(2, 6)}`;
    const app = await createApplication({ slug, name: slug }, db);
    await recordAuditEntry(
      {
        applicationId: app.id,
        environment: "live",
        action: "webhook_endpoint.created",
        resourceType: "webhook_endpoint",
        resourceId: "whep_1",
        actor: { id: "admin" },
      },
      db,
    );
    const [row] = await db
      .select()
      .from(operatorAuditLog)
      .where(and(eq(operatorAuditLog.applicationId, app.id)));
    expect(row.environment).toBe("live");
  });
});
