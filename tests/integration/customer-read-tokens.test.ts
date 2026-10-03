import { afterAll, describe, expect, it } from "vitest";
import { POST as balancePOST } from "../../src/app/api/credits/balance/route";
import { DELETE as revokeDELETE } from "../../src/app/api/customer-read-tokens/[tokenId]/route";
import { POST as issuePOST } from "../../src/app/api/customer-read-tokens/route";
import { getDb, getSqlClient } from "../../src/db/client";
import {
  createApplication,
  issueApplicationCredential,
} from "../../src/modules/applications/service";
import { grantCredits } from "../../src/modules/credits/service";
import { createApplicationCustomer } from "../../src/modules/customers/service";

/**
 * Customer read tokens (#138): the end-state auth tier for read endpoints.
 * Issued by the application backend with its credential; scoped to ONE
 * customer + environment; mandatory expiry; revocable; cross-app use is
 * impossible by construction (the application comes FROM the token).
 */
const db = getDb();

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

async function seedApp(slugSeed: string, otherExternalId?: string) {
  const app = await createApplication(
    {
      slug: `crt-${slugSeed}-${Math.random().toString(36).slice(2, 8)}`,
      name: "CRT",
    },
    db,
  );
  const customer = await createApplicationCustomer(
    { applicationId: app.id, externalCustomerId: "user-1" },
    db,
  );
  await grantCredits({
    applicationId: app.id,
    applicationCustomerId: customer.id,
    creditType: "gen.credits",
    amount: 250,
    transactionType: "grant.purchase",
    sourceType: "order",
    sourceId: "seed",
    idempotencyKey: `crt-seed-${app.id}`,
  });
  if (otherExternalId) {
    await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: otherExternalId },
      db,
    );
  }
  const credential = await issueApplicationCredential(app.id, "server", db);
  return { app, customer, credentialSecret: credential.secret };
}

function issueRequest(
  credentialSecret: string,
  body: Record<string, unknown>,
): Request {
  return new Request("https://console.test/api/customer-read-tokens", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      host: "console.test",
      "content-type": "application/json",
      authorization: `Bearer ${credentialSecret}`,
    },
  });
}

function balanceRequest(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Request {
  return new Request("https://host.test/api/credits/balance", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      host: "host.test",
      "content-type": "application/json",
      ...headers,
    },
  });
}

describe("customer read tokens (#138)", () => {
  it("issues via credential, reads the scoped customer's balance, and honors customer scoping", async () => {
    const { app, credentialSecret } = await seedApp("main", "user-2");

    const issued = await issuePOST(
      issueRequest(credentialSecret, { externalCustomerId: "user-1" }),
    );
    expect(issued.status).toBe(201);
    const issuedBody = (await issued.json()) as {
      id: string;
      token: string;
      expiresAt: string;
      externalCustomerId: string;
    };
    expect(issuedBody.token).toMatch(/^mprt_/);
    expect(issuedBody.externalCustomerId).toBe("user-1");

    // Token reads its OWN customer's balance without any externalCustomerId.
    const read = await balancePOST(
      balanceRequest(
        { authorization: `Bearer ${issuedBody.token}` },
        { creditType: "gen.credits", environment: "test" },
      ),
    );
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { available: number };
    expect(readBody.available).toBe(250);

    // Explicit same customer also works.
    const readExplicit = await balancePOST(
      balanceRequest(
        { authorization: `Bearer ${issuedBody.token}` },
        {
          creditType: "gen.credits",
          externalCustomerId: "user-1",
          environment: "test",
        },
      ),
    );
    expect(readExplicit.status).toBe(200);

    // Token CANNOT read the application's OTHER customer.
    const foreign = await balancePOST(
      balanceRequest(
        { authorization: `Bearer ${issuedBody.token}` },
        {
          creditType: "gen.credits",
          externalCustomerId: "user-2",
          environment: "test",
        },
      ),
    );
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({
      code: "customer_mismatch",
    });
    expect(app.id).toBeTruthy();
  });

  it("rejects unknown, expired, and revoked tokens; environment mismatch is 403", async () => {
    const { app, credentialSecret } = await seedApp("lifecycle");

    const issued = await issuePOST(
      issueRequest(credentialSecret, { externalCustomerId: "user-1" }),
    );
    const issuedBody = (await issued.json()) as { id: string; token: string };

    const unknown = await balancePOST(
      balanceRequest(
        { authorization: "Bearer mprt_unknown" },
        { creditType: "gen.credits", environment: "test" },
      ),
    );
    expect(unknown.status).toBe(401);
    await expect(unknown.json()).resolves.toMatchObject({
      code: "read_token_invalid",
    });

    // Expire it directly.
    await db.execute(
      // expiresAt is enforced by the validator; force it into the past.
      // eslint-disable-next-line -- raw SQL is the cleanest way to simulate time.
      (await import("drizzle-orm"))
        .sql`UPDATE customer_read_tokens SET expires_at = now() - interval '1 minute' WHERE id = ${issuedBody.id}`,
    );
    const expired = await balancePOST(
      balanceRequest(
        { authorization: `Bearer ${issuedBody.token}` },
        { creditType: "gen.credits", environment: "test" },
      ),
    );
    expect(expired.status).toBe(401);

    // Re-issue, then revoke via the credential-authenticated route.
    const reissued = await issuePOST(
      issueRequest(credentialSecret, { externalCustomerId: "user-1" }),
    );
    const reissuedBody = (await reissued.json()) as {
      id: string;
      token: string;
    };
    const revoked = await revokeDELETE(
      new Request("https://console.test/api/customer-read-tokens", {
        method: "DELETE",
        headers: { authorization: `Bearer ${credentialSecret}` },
      }),
      { params: Promise.resolve({ tokenId: reissuedBody.id }) },
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await balancePOST(
      balanceRequest(
        { authorization: `Bearer ${reissuedBody.token}` },
        { creditType: "gen.credits", environment: "test" },
      ),
    );
    expect(afterRevoke.status).toBe(401);

    // Issuing for live, then reading with environment=test body -> 403.
    const liveIssued = await issuePOST(
      issueRequest(credentialSecret, {
        externalCustomerId: "user-1",
        environment: "live",
      }),
    );
    const liveBody = (await liveIssued.json()) as { token: string };
    const envMismatch = await balancePOST(
      balanceRequest(
        { authorization: `Bearer ${liveBody.token}` },
        { creditType: "gen.credits", environment: "test" },
      ),
    );
    expect(envMismatch.status).toBe(403);
    await expect(envMismatch.json()).resolves.toMatchObject({
      code: "environment_mismatch",
    });
    expect(app.id).toBeTruthy();
  });

  it("requires a credential to issue (host-only is not enough) and validates ttl", async () => {
    const { app } = await seedApp("gate");
    // Host-only issuance attempt: no credential -> credential_required.
    const hostIssued = await issuePOST(
      new Request("https://host.test/api/customer-read-tokens", {
        method: "POST",
        body: JSON.stringify({ externalCustomerId: "user-1" }),
        headers: { host: "host.test", "content-type": "application/json" },
      }),
    );
    expect(hostIssued.status).toBe(401);
    // An unregistered host yields context_not_found; a REGISTERED branded
    // host would yield credential_required. Both are 401 fail-closed.
    await expect(hostIssued.json()).resolves.toMatchObject({
      code: expect.stringMatching(/credential_required|unauthorized/),
    });

    const credential = await issueApplicationCredential(app.id, "server", db);
    const badTtl = await issuePOST(
      issueRequest(credential.secret, {
        externalCustomerId: "user-1",
        ttlSeconds: 5,
      }),
    );
    expect(badTtl.status).toBe(400);
    await expect(badTtl.json()).resolves.toMatchObject({ code: "invalid_ttl" });
  });
});
