/**
 * Example 2 — credits + metered usage on the same packaged SDK.
 * Demonstrates the documented no-double-count interaction model (#62).
 */
import { createMonetPlaneClient } from "@monetplane/sdk/server";

const monetplane = createMonetPlaneClient({
  baseUrl: process.env.MONETPLANE_BASE_URL!,
  appSecret: process.env.MONETPLANE_APP_SECRET!,
});

export async function runAgentJob(externalCustomerId: string) {
  const balance = await monetplane.getCreditBalance(
    externalCustomerId,
    "agent.run",
    "test",
  );

  if (balance.available > 0) {
    // Prepaid credits: consume from the balance.
    const debit = await monetplane.debitCredits({
      externalCustomerId,
      creditType: "agent.run",
      amount: 1,
      sourceType: "job",
      sourceId: `job-${Date.now()}`,
      idempotencyKey: `debit-${Date.now()}`,
      environment: "test",
    });
    return { model: "credits" as const, availableAfter: debit.availableAfter };
  }

  // Metered usage: report without touching the credit balance.
  const usage = await monetplane.reportUsage({
    externalCustomerId,
    meterKey: "agent.jobs",
    quantity: 1,
    sourceType: "job",
    sourceId: `job-${Date.now()}`,
    idempotencyKey: `usage-${Date.now()}`,
    environment: "test",
  });
  return { model: "metered" as const, duplicate: usage.duplicate };
}
