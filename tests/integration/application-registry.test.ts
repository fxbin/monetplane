import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  applicationCredentials,
  applicationDomains,
  applications,
} from "../../src/modules/applications/schema";
import {
  ApplicationContextMismatchError,
  resolveApplicationContext,
} from "../../src/modules/applications/context";
import {
  assertAllowedCallbackUrl,
  authenticateApplicationCredential,
  createApplication,
  issueApplicationCredential,
  registerApplicationDomain,
  registerCallbackOrigin,
  resolveApplicationByHost,
} from "../../src/modules/applications/service";

const db = getDb();

beforeEach(async () => {
  await db.delete(applications);
});

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

describe("application registry integration", () => {
  it("isolates two applications while resolving branded hosts", async () => {
    const aha = await createApplication({ slug: "ahaframe", name: "AhaFrame" }, db);
    const pic = await createApplication({ slug: "pictofu", name: "PicTofu" }, db);

    await registerApplicationDomain(aha.id, "billing.ahaframe.test", {}, db);
    await registerApplicationDomain(pic.id, "billing.pictofu.test", {}, db);

    await expect(
      resolveApplicationByHost("billing.ahaframe.test", db),
    ).resolves.toMatchObject({ id: aha.id, slug: "ahaframe" });
    await expect(
      resolveApplicationByHost("billing.pictofu.test", db),
    ).resolves.toMatchObject({ id: pic.id, slug: "pictofu" });
  });

  it("rejects duplicate domain registration across applications", async () => {
    const first = await createApplication({ slug: "first", name: "First" }, db);
    const second = await createApplication({ slug: "second", name: "Second" }, db);

    await registerApplicationDomain(first.id, "billing.shared.test", {}, db);

    await expect(
      registerApplicationDomain(second.id, "billing.shared.test", {}, db),
    ).rejects.toThrow();
  });

  it("allows only registered callback origins", async () => {
    const app = await createApplication({ slug: "callbacks", name: "Callbacks" }, db);
    await registerCallbackOrigin(app.id, "https://product.test/billing/success", db);

    await expect(
      assertAllowedCallbackUrl(
        app.id,
        "https://product.test/billing/complete?order=1",
        db,
      ),
    ).resolves.toBe("https://product.test/billing/complete?order=1");

    await expect(
      assertAllowedCallbackUrl(app.id, "https://attacker.test/redirect", db),
    ).rejects.toThrow("not allowed");
  });

  it("stores only credential hashes and authenticates the one-time secret", async () => {
    const app = await createApplication({ slug: "credential", name: "Credential" }, db);
    const issued = await issueApplicationCredential(app.id, "server", db);

    const [stored] = await db
      .select()
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, issued.id))
      .limit(1);

    expect(issued.secret).toMatch(/^mp_app_/);
    expect(stored?.secretHash).toBeTruthy();
    expect(stored?.secretHash).not.toBe(issued.secret);
    await expect(
      authenticateApplicationCredential(issued.secret, db),
    ).resolves.toMatchObject({ id: app.id });
  });

  it("fails closed when host and credential point at different applications", async () => {
    const hostApp = await createApplication({ slug: "host-app", name: "Host App" }, db);
    const credentialApp = await createApplication(
      { slug: "credential-app", name: "Credential App" },
      db,
    );

    await registerApplicationDomain(hostApp.id, "billing.host.test", {}, db);
    const credential = await issueApplicationCredential(
      credentialApp.id,
      "server",
      db,
    );

    const request = new Request("https://billing.host.test/api/application-context", {
      headers: {
        host: "billing.host.test",
        authorization: `Bearer ${credential.secret}`,
      },
    });

    await expect(resolveApplicationContext(request, db)).rejects.toBeInstanceOf(
      ApplicationContextMismatchError,
    );
  });

  it("ignores caller-supplied application ids and trusts derived context", async () => {
    const hostApp = await createApplication({ slug: "trusted", name: "Trusted" }, db);
    const otherApp = await createApplication({ slug: "other", name: "Other" }, db);
    await registerApplicationDomain(hostApp.id, "billing.trusted.test", {}, db);

    const request = new Request("https://billing.trusted.test/api/application-context", {
      headers: {
        host: "billing.trusted.test",
        "x-application-id": otherApp.id,
      },
    });

    await expect(resolveApplicationContext(request, db)).resolves.toMatchObject({
      application: { id: hostApp.id },
      source: "host",
    });
  });

  it("cascades application-owned routing and credential data", async () => {
    const app = await createApplication({ slug: "cascade", name: "Cascade" }, db);
    await registerApplicationDomain(app.id, "billing.cascade.test", {}, db);
    await issueApplicationCredential(app.id, "server", db);

    await db.delete(applications);

    await expect(db.select().from(applicationDomains)).resolves.toHaveLength(0);
    await expect(db.select().from(applicationCredentials)).resolves.toHaveLength(0);
  });
});
