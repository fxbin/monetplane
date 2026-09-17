import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  orders,
  payments,
  refunds,
  subscriptions,
} from "@/modules/commerce/schema";
import { revokeEntitlementsBySource } from "@/modules/entitlements/service";
import { billingOperations } from "@/modules/operations/schema";
import type {
  NormalizedRefund,
  NormalizedSubscription,
  ProviderMode,
} from "@/modules/providers/contract";
import { classifyProviderOperationFailure } from "@/modules/providers/contract";
import {
  cancelProviderSubscription,
  refundProviderPayment,
} from "@/modules/providers/runtime";
import { providerConnections } from "@/modules/providers/schema";
import {
  getOperationById,
  getPaymentDetail,
  getSubscriptionDetail,
} from "./billing-operations";

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is missing from the normalized provider result`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} is missing from the normalized provider result`);
  }
  return value;
}

async function findOperationByIdempotencyKey(
  applicationId: string,
  idempotencyKey: string,
) {
  const db = getDb();
  const [operation] = await db
    .select()
    .from(billingOperations)
    .where(
      and(
        eq(billingOperations.applicationId, applicationId),
        eq(billingOperations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return operation;
}

async function createOrGetOperation(input: {
  applicationId: string;
  type: "refund" | "cancel_subscription";
  resourceType: "payment" | "subscription";
  resourceId: string;
  providerConnectionId: string;
  providerResourceId: string;
  environment: string;
  idempotencyKey: string;
  retryOfOperationId?: string | null;
  attemptNumber?: number;
}) {
  const db = getDb();
  const [inserted] = await db
    .insert(billingOperations)
    .values({
      id: `bop_${randomUUID()}`,
      ...input,
      normalizedResult: {},
    })
    .onConflictDoNothing({
      target: [
        billingOperations.applicationId,
        billingOperations.idempotencyKey,
      ],
    })
    .returning();
  if (inserted) return { operation: inserted, created: true } as const;

  const existing = await findOperationByIdempotencyKey(
    input.applicationId,
    input.idempotencyKey,
  );
  if (!existing) throw new Error("Failed to resolve billing operation");
  return { operation: existing, created: false } as const;
}

async function updateOperation(
  applicationId: string,
  operationId: string,
  values: Partial<typeof billingOperations.$inferInsert>,
) {
  const db = getDb();
  const [updated] = await db
    .update(billingOperations)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(billingOperations.id, operationId),
        eq(billingOperations.applicationId, applicationId),
      ),
    )
    .returning();
  if (!updated) throw new Error("Billing operation update failed");
  return updated;
}

async function assertOperationEnvironment(
  applicationId: string,
  providerConnectionId: string,
  providerMode: ProviderMode,
) {
  const db = getDb();
  const [connection] = await db
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, providerConnectionId),
        eq(providerConnections.applicationId, applicationId),
        eq(providerConnections.mode, providerMode),
      ),
    )
    .limit(1);
  if (!connection) {
    throw new Error(
      "Billing operation does not belong to the selected environment",
    );
  }
}

async function recordProviderFailure(
  applicationId: string,
  operationId: string,
  error: unknown,
) {
  await updateOperation(applicationId, operationId, {
    status: "failed",
    failureKind: classifyProviderOperationFailure(error),
    errorMessage:
      error instanceof Error ? error.message : "Provider operation failed",
  });
}

async function markNeedsReconciliation(
  applicationId: string,
  operationId: string,
  error: unknown,
) {
  try {
    await updateOperation(applicationId, operationId, {
      status: "needs_reconciliation",
      errorMessage:
        error instanceof Error ? error.message : "Local reconciliation failed",
    });
  } catch {
    // The journal row is already durable. A later reconciliation pass can inspect it
    // even if this best-effort status transition is temporarily unavailable.
  }
}

function assertOperationCanProceed(
  operation: typeof billingOperations.$inferSelect,
  created: boolean,
) {
  if (created) return;
  if (operation.status === "completed") return;
  if (
    operation.status === "provider_succeeded" ||
    operation.status === "needs_reconciliation"
  ) {
    return;
  }
  if (operation.status === "pending_provider") {
    throw new Error(
      "This billing operation has an uncertain provider outcome. Investigate provider state before taking further action.",
    );
  }
  if (operation.failureKind === "rejected") {
    throw new Error(
      operation.errorMessage
        ? `The provider rejected the previous attempt. Correct the input or provider configuration, then use the explicit retry action: ${operation.errorMessage}`
        : "The provider rejected the previous attempt. Correct the input or provider configuration, then use the explicit retry action.",
    );
  }
  throw new Error(
    operation.errorMessage
      ? `The previous provider outcome is uncertain and must not be retried automatically: ${operation.errorMessage}`
      : "The previous provider outcome is uncertain and must not be retried automatically. Investigate provider state first.",
  );
}

async function resumeExistingOperation(
  applicationId: string,
  operation: typeof billingOperations.$inferSelect,
  providerMode: ProviderMode,
) {
  await assertOperationEnvironment(
    applicationId,
    operation.providerConnectionId,
    providerMode,
  );
  assertOperationCanProceed(operation, false);
  if (operation.status === "completed") return operation;
  if (
    operation.status === "provider_succeeded" ||
    operation.status === "needs_reconciliation"
  ) {
    return reconcileBillingOperation(applicationId, operation.id, providerMode);
  }
  throw new Error("Billing operation cannot be resumed automatically");
}

export async function refundPaymentWithJournal(
  applicationId: string,
  paymentId: string,
  providerMode: ProviderMode,
) {
  const payment = await getPaymentDetail(
    applicationId,
    paymentId,
    providerMode,
  );
  const idempotencyKey = `refund:${payment.id}:full`;
  const existing = await findOperationByIdempotencyKey(
    applicationId,
    idempotencyKey,
  );
  if (existing) {
    return resumeExistingOperation(applicationId, existing, providerMode);
  }

  if (!payment.refundEligibility.eligible) {
    throw new Error(
      payment.refundEligibility.reason ?? "This payment cannot be refunded.",
    );
  }

  const { operation, created } = await createOrGetOperation({
    applicationId,
    type: "refund",
    resourceType: "payment",
    resourceId: payment.id,
    providerConnectionId: payment.providerConnectionId,
    environment: payment.environment,
    providerResourceId: payment.providerPaymentId,
    idempotencyKey,
  });
  if (!created) {
    return resumeExistingOperation(applicationId, operation, providerMode);
  }

  let result: NormalizedRefund;
  try {
    result = await refundProviderPayment(
      applicationId,
      payment.providerConnectionId,
      {
        providerPaymentId: payment.providerPaymentId,
        amountMinor: payment.amountMinor,
      },
    );
  } catch (error) {
    await recordProviderFailure(applicationId, operation.id, error);
    throw error;
  }

  await updateOperation(applicationId, operation.id, {
    status: "provider_succeeded",
    failureKind: null,
    normalizedResult: { ...result },
    errorMessage: null,
  });
  return reconcileBillingOperation(applicationId, operation.id, providerMode);
}

export async function cancelSubscriptionWithJournal(
  applicationId: string,
  subscriptionId: string,
  providerMode: ProviderMode,
) {
  const subscription = await getSubscriptionDetail(
    applicationId,
    subscriptionId,
    providerMode,
  );
  const idempotencyKey = `cancel:${subscription.id}`;
  const existing = await findOperationByIdempotencyKey(
    applicationId,
    idempotencyKey,
  );
  if (existing) {
    return resumeExistingOperation(applicationId, existing, providerMode);
  }

  if (!subscription.cancellationEligibility.eligible) {
    throw new Error(
      subscription.cancellationEligibility.reason ??
        "This subscription cannot be cancelled.",
    );
  }

  const { operation, created } = await createOrGetOperation({
    applicationId,
    type: "cancel_subscription",
    resourceType: "subscription",
    resourceId: subscription.id,
    providerConnectionId: subscription.providerConnectionId,
    environment: subscription.environment,
    providerResourceId: subscription.providerSubscriptionId,
    idempotencyKey,
  });
  if (!created) {
    return resumeExistingOperation(applicationId, operation, providerMode);
  }

  let result: NormalizedSubscription;
  try {
    result = await cancelProviderSubscription(
      applicationId,
      subscription.providerConnectionId,
      { providerSubscriptionId: subscription.providerSubscriptionId },
    );
  } catch (error) {
    await recordProviderFailure(applicationId, operation.id, error);
    throw error;
  }

  await updateOperation(applicationId, operation.id, {
    status: "provider_succeeded",
    failureKind: null,
    normalizedResult: { ...result },
    errorMessage: null,
  });
  return reconcileBillingOperation(applicationId, operation.id, providerMode);
}

export async function retryBillingOperation(
  applicationId: string,
  operationId: string,
  providerMode: ProviderMode,
) {
  const source = await getOperationById(applicationId, operationId);
  await assertOperationEnvironment(
    applicationId,
    source.providerConnectionId,
    providerMode,
  );

  if (source.status !== "failed") {
    throw new Error("Only failed provider operations can be retried.");
  }
  if (source.failureKind !== "rejected") {
    throw new Error(
      "This provider outcome is uncertain. Do not retry it until provider state has been investigated.",
    );
  }

  let type: "refund" | "cancel_subscription";
  let resourceType: "payment" | "subscription";
  let amountMinor: number | undefined;

  if (source.type === "refund") {
    if (source.resourceType !== "payment") {
      throw new Error("Refund journal has an invalid resource type.");
    }
    type = "refund";
    resourceType = "payment";
    const payment = await getPaymentDetail(
      applicationId,
      source.resourceId,
      providerMode,
    );
    if (!payment.refundEligibility.eligible) {
      throw new Error(
        payment.refundEligibility.reason ??
          "This payment cannot be retried for refund.",
      );
    }
    if (
      payment.providerConnectionId !== source.providerConnectionId ||
      payment.providerPaymentId !== source.providerResourceId
    ) {
      throw new Error(
        "Payment provider routing changed after the failed attempt. Start a new operator review instead of retrying the old operation.",
      );
    }
    amountMinor = payment.amountMinor;
  } else if (source.type === "cancel_subscription") {
    if (source.resourceType !== "subscription") {
      throw new Error("Cancellation journal has an invalid resource type.");
    }
    type = "cancel_subscription";
    resourceType = "subscription";
    const subscription = await getSubscriptionDetail(
      applicationId,
      source.resourceId,
      providerMode,
    );
    if (!subscription.cancellationEligibility.eligible) {
      throw new Error(
        subscription.cancellationEligibility.reason ??
          "This subscription cannot be retried for cancellation.",
      );
    }
    if (
      subscription.providerConnectionId !== source.providerConnectionId ||
      subscription.providerSubscriptionId !== source.providerResourceId
    ) {
      throw new Error(
        "Subscription provider routing changed after the failed attempt. Start a new operator review instead of retrying the old operation.",
      );
    }
  } else {
    throw new Error(`Unsupported billing operation type: ${source.type}`);
  }

  const attemptNumber = source.attemptNumber + 1;
  const { operation, created } = await createOrGetOperation({
    applicationId,
    type,
    resourceType,
    resourceId: source.resourceId,
    providerConnectionId: source.providerConnectionId,
    providerResourceId: source.providerResourceId,
    environment: source.environment,
    idempotencyKey: `retry:${source.id}`,
    retryOfOperationId: source.id,
    attemptNumber,
  });
  if (!created) {
    return resumeExistingOperation(applicationId, operation, providerMode);
  }

  if (type === "refund") {
    let result: NormalizedRefund;
    try {
      result = await refundProviderPayment(
        applicationId,
        source.providerConnectionId,
        {
          providerPaymentId: source.providerResourceId,
          amountMinor,
        },
      );
    } catch (error) {
      await recordProviderFailure(applicationId, operation.id, error);
      throw error;
    }

    await updateOperation(applicationId, operation.id, {
      status: "provider_succeeded",
      failureKind: null,
      normalizedResult: { ...result },
      errorMessage: null,
    });
    return reconcileBillingOperation(applicationId, operation.id, providerMode);
  }

  let result: NormalizedSubscription;
  try {
    result = await cancelProviderSubscription(
      applicationId,
      source.providerConnectionId,
      { providerSubscriptionId: source.providerResourceId },
    );
  } catch (error) {
    await recordProviderFailure(applicationId, operation.id, error);
    throw error;
  }

  await updateOperation(applicationId, operation.id, {
    status: "provider_succeeded",
    failureKind: null,
    normalizedResult: { ...result },
    errorMessage: null,
  });
  return reconcileBillingOperation(applicationId, operation.id, providerMode);
}

export async function reconcileBillingOperation(
  applicationId: string,
  operationId: string,
  providerMode: ProviderMode,
) {
  const operation = await getOperationById(applicationId, operationId);
  await assertOperationEnvironment(
    applicationId,
    operation.providerConnectionId,
    providerMode,
  );

  if (operation.status === "completed") return operation;
  if (
    operation.status !== "provider_succeeded" &&
    operation.status !== "needs_reconciliation"
  ) {
    throw new Error(
      "Only provider-succeeded or reconciliation-needed operations can be reconciled.",
    );
  }

  const db = getDb();
  try {
    if (operation.type === "refund") {
      const result = operation.normalizedResult;
      const providerRefundId = requiredString(
        result.providerRefundId,
        "Provider refund ID",
      );
      const status = requiredString(result.status, "Refund status");
      const amountMinor = optionalNumber(result.amountMinor);

      const [payment] = await db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.id, operation.resourceId),
            eq(payments.applicationId, applicationId),
          ),
        )
        .limit(1);
      if (!payment) {
        throw new Error("Payment disappeared before reconciliation");
      }
      const orderId = payment.orderId;

      await db.transaction(async (tx) => {
        await tx
          .insert(refunds)
          .values({
            id: `ref_${randomUUID()}`,
            applicationId,
            orderId,
            paymentId: payment.id,
            providerConnectionId: payment.providerConnectionId,
            environment: payment.environment,
            providerRefundId,
            status,
            amountMinor: amountMinor ?? payment.amountMinor,
          })
          .onConflictDoUpdate({
            target: [refunds.providerConnectionId, refunds.providerRefundId],
            set: {
              status,
              amountMinor: amountMinor ?? payment.amountMinor,
              updatedAt: new Date(),
            },
          });

        if (status === "succeeded") {
          await tx
            .update(payments)
            .set({ status: "refunded", updatedAt: new Date() })
            .where(eq(payments.id, payment.id));

          if (orderId) {
            await tx
              .update(orders)
              .set({ status: "refunded", updatedAt: new Date() })
              .where(eq(orders.id, orderId));
            await revokeEntitlementsBySource(
              applicationId,
              "order",
              orderId,
              tx,
            );
          }
        }

        await tx
          .update(billingOperations)
          .set({
            status: "completed",
            errorMessage: null,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(billingOperations.id, operation.id));
      });
    } else if (operation.type === "cancel_subscription") {
      const result = operation.normalizedResult;
      const status = requiredString(result.status, "Subscription status");
      const currentPeriodStart = optionalString(result.currentPeriodStart);
      const currentPeriodEnd = optionalString(result.currentPeriodEnd);
      const cancelAtPeriodEnd = requiredBoolean(
        result.cancelAtPeriodEnd,
        "Cancel-at-period-end flag",
      );

      const [subscription] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.id, operation.resourceId),
            eq(subscriptions.applicationId, applicationId),
          ),
        )
        .limit(1);
      if (!subscription) {
        throw new Error("Subscription disappeared before reconciliation");
      }

      await db.transaction(async (tx) => {
        await tx
          .update(subscriptions)
          .set({
            status,
            currentPeriodStart: currentPeriodStart
              ? new Date(currentPeriodStart)
              : subscription.currentPeriodStart,
            currentPeriodEnd: currentPeriodEnd
              ? new Date(currentPeriodEnd)
              : subscription.currentPeriodEnd,
            cancelAtPeriodEnd,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.id, subscription.id));

        if (status === "cancelled" && !cancelAtPeriodEnd) {
          await revokeEntitlementsBySource(
            applicationId,
            "subscription",
            subscription.id,
            tx,
          );
        }

        await tx
          .update(billingOperations)
          .set({
            status: "completed",
            errorMessage: null,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(billingOperations.id, operation.id));
      });
    } else {
      throw new Error(`Unsupported billing operation type: ${operation.type}`);
    }
  } catch (error) {
    await markNeedsReconciliation(applicationId, operation.id, error);
    throw error;
  }

  return getOperationById(applicationId, operation.id);
}
