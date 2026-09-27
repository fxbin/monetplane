import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSqlClient } from "../../src/db/client";
import { applications } from "../../src/modules/applications/schema";
import { createApplication } from "../../src/modules/applications/service";
import { creditTransactions } from "../../src/modules/credits/schema";
import { customers } from "../../src/modules/customers/schema";
import { createApplicationCustomer } from "../../src/modules/customers/service";
import { mockProviderAdapter } from "../../src/modules/providers/adapters/mock";
import {
  clearProviderAdaptersForTests,
  registerProviderAdapter,
} from "../../src/modules/providers/registry";
import {
  getCustomerWorkspace,
  getCustomerWorkspaceList,
  grantCustomerCredits,
} from "../../src/server/control-plane/customer-workspace";

const db = getDb();
const encryptionKey = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(async () => {
  process.env.MONETPLANE_ENCRYPTION_KEY = encryptionKey;
  clearProviderAdaptersForTests();
  registerProviderAdapter(mockProviderAdapter);
  await db.delete(applications);
  await db.delete(customers);
});

afterAll(async () => {
  delete process.env.MONETPLANE_ENCRYPTION_KEY;
  clearProviderAdaptersForTests();
  await getSqlClient().end({ timeout: 1 });
});

describe("customer billing workspace", () => {
  it("keeps list/detail and manual credit grants application-isolated", async () => {
    const firstApp = await createApplication(
      { slug: "workspace-a", name: "Workspace A" },
      db,
    );
    const secondApp = await createApplication(
      { slug: "workspace-b", name: "Workspace B" },
      db,
    );
    const firstCustomer = await createApplicationCustomer(
      {
        applicationId: firstApp.id,
        externalCustomerId: "same-external-id",
        email: "first@example.com",
      },
      db,
    );
    const secondCustomer = await createApplicationCustomer(
      {
        applicationId: secondApp.id,
        externalCustomerId: "same-external-id",
        email: "second@example.com",
      },
      db,
    );

    await grantCustomerCredits(firstApp.id, firstCustomer.id, {
      creditType: "generation",
      amount: 250,
      note: "support adjustment",
    });

    const firstList = await getCustomerWorkspaceList(firstApp.id);
    const secondList = await getCustomerWorkspaceList(secondApp.id);
    expect(firstList).toHaveLength(1);
    expect(firstList[0]).toMatchObject({
      id: firstCustomer.id,
      credits: { available: 250, reserved: 0 },
    });
    expect(secondList).toHaveLength(1);
    expect(secondList[0]).toMatchObject({
      id: secondCustomer.id,
      credits: { available: 0, reserved: 0 },
    });

    const workspace = await getCustomerWorkspace(firstApp.id, firstCustomer.id);
    expect(workspace.creditLedger[0]).toMatchObject({
      type: "adjustment.admin",
      amount: 250,
      sourceType: "admin",
    });
    await expect(
      getCustomerWorkspace(firstApp.id, secondCustomer.id),
    ).rejects.toThrow("Customer not found");
  });

  it("records manual grants in the shared ledger table", async () => {
    const app = await createApplication(
      { slug: "workspace-ledger", name: "Workspace Ledger" },
      db,
    );
    const customer = await createApplicationCustomer(
      { applicationId: app.id, externalCustomerId: "ledger-user" },
      db,
    );
    await grantCustomerCredits(app.id, customer.id, {
      creditType: "generation",
      amount: 50,
    });
    const rows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.applicationCustomerId, customer.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "adjustment.admin",
      amount: 50,
    });
  });
});
