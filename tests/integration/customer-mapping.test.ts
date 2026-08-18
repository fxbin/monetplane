import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import { customers } from "../../src/modules/customers/schema";
import {
  createApplicationCustomer,
  findApplicationCustomer,
} from "../../src/modules/customers/service";

const db = getDb();

beforeEach(async () => {
  await db.delete(applications);
  await db.delete(customers);
});

afterAll(async () => {
  await getSqlClient().end({ timeout: 1 });
});

describe("customer mapping", () => {
  it("does not auto-merge customers that share an email", async () => {
    const firstApp = await createApplication(
      { slug: "first", name: "First" },
      db,
    );
    const secondApp = await createApplication(
      { slug: "second", name: "Second" },
      db,
    );

    const first = await createApplicationCustomer(
      {
        applicationId: firstApp.id,
        externalCustomerId: "user-1",
        email: "same@example.com",
      },
      db,
    );
    const second = await createApplicationCustomer(
      {
        applicationId: secondApp.id,
        externalCustomerId: "user-2",
        email: "same@example.com",
      },
      db,
    );

    expect(first.customerId).not.toBe(second.customerId);
  });

  it("links across applications only when explicitly requested", async () => {
    const firstApp = await createApplication(
      { slug: "linked-a", name: "Linked A" },
      db,
    );
    const secondApp = await createApplication(
      { slug: "linked-b", name: "Linked B" },
      db,
    );

    const first = await createApplicationCustomer(
      { applicationId: firstApp.id, externalCustomerId: "local-a" },
      db,
    );
    const second = await createApplicationCustomer(
      {
        applicationId: secondApp.id,
        externalCustomerId: "local-b",
        customerId: first.customerId,
      },
      db,
    );

    expect(second.customerId).toBe(first.customerId);
  });

  it("enforces external IDs per application but allows the same ID in another app", async () => {
    const firstApp = await createApplication(
      { slug: "scope-a", name: "Scope A" },
      db,
    );
    const secondApp = await createApplication(
      { slug: "scope-b", name: "Scope B" },
      db,
    );

    await createApplicationCustomer(
      { applicationId: firstApp.id, externalCustomerId: "user-123" },
      db,
    );

    await expect(
      createApplicationCustomer(
        { applicationId: firstApp.id, externalCustomerId: "user-123" },
        db,
      ),
    ).rejects.toThrow();

    await expect(
      createApplicationCustomer(
        { applicationId: secondApp.id, externalCustomerId: "user-123" },
        db,
      ),
    ).resolves.toBeTruthy();

    await expect(
      findApplicationCustomer(firstApp.id, "user-123", db),
    ).resolves.toMatchObject({ applicationId: firstApp.id });
  });
});
