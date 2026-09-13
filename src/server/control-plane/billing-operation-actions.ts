import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { orders, payments, refunds, subscriptions } from "@/modules/commerce/schema";
import { revokeEntitlementsBySource } from "@/modules/entitlements/service";
import { billingOperations } from "@/modules/operations/schema";
import {
  cancelProviderSubscription,
  refundProviderPayment,
} from "@/modules/providers/runtime";
import {
  getOperationById,
  getPaymentDetail,
  getSubscriptionDetail,
} from "./billing-operations";

function requiredString(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is missing from the normalized provider result`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} is missing from the normalized provider result`);
  }
  return value;
}

async function createOrGetOperation(input: {
  applicationId: string;
  type: "refund" | "cancel_subscription";
  resourceType: "payment" | "subscription";
  resourceId: string;
  providerConnectionId: string;
  providerResourceId: string;
  idempotencyKey: string;
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
      target: [billingOperations.applicationId, billingOperations.idempotencyKey],
    })
    .returning();
  if (inserted) return { operation: inserted, created: true } as const;

  const [existing] = await db
    .select()
    .from(billingOperations)
    .where(
      and(
        eq(billingOperations.applicationId, input.applicationId),
        eq(billingOperations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
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

async function recordProviderFailure(
  applicationId: string,
  operationId: string,
  error: unknown,
) {
  await updateOperation(applicationId, operationId, {
    status: "failed",
    errorMessage: error instanceof Error ? error.message : "Provider operation failed",
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
    // The operation is already durable. A later inspection/reconciliation pass can
    // recover it even if this best-effort status update is unavailable.
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
      "This billing operation is already in progress or has an uncertain provider outcome. Reconcile it before retrying.",
    );
  }
  throw new Error(
    operation.errorMessage
      ? `The previous billing operation failed: ${operation.errorMessage}`
      : "The previous billing operation failed. Inspect it before retrying.",
  );
}

export async function refundPaymentWithJournal(
  applicationId: string,
  paymentId: string,
) {
  const payment = await getPaymentDetail(applicationId, paymentId);
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
    providerResourceId: payment.providerPaymentId,
    idempotencyKey: `refund:${payment.id}:full`,
  });
  assertOperationCanProceed(operation, created);

  if (operation.status === "completed") return operation;
  if (
    operation.status === "provider_succeeded" ||
    operation.status === "needs_reconciliation"
  ) {
    return reconcileBillingOperation(applicationId, operation.id);
  }

  let result;
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
    normalizedResult: { ...result },
    errorMessage: null,
  });
  return reconcileBillingOperation(applicationId, operation.id);
}

export async function cancelSubscriptionWithJournal(
  applicationId: string,
  subscriptionId: string,
) {
  const subscription = await getSubscriptionDetail(applicationId, subscriptionId);
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
    providerResourceId: subscription.providerSubscriptionId,
    idempotencyKey: `cancel:${subscription.id}`,
  });
  assertOperationCanProceed(operation, created);

  if (operation.status === "completed") return operation;
  if (
    operation.status === "provider_succeeded" ||
    operation.status === "needs_reconciliation"
  ) {
    return reconcileBillingOperation(applicationId, operation.id);
  }

  let result;
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
    normalizedResult: { ...result },
    errorMessage: null,
  });
  return reconcileBillingOperation(applicationId, operation.id);
}

export async function reconcileBillingOperation(
  applicationId: string,
  operationId: string,
) {
  const operation = await getOperationById(applicationId, operationId);
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
      if (!payment) throw new Error("Payment disappeared before reconciliation");
      if (!payment.orderId) throw new Error("Refunded payment has no order");

      await db.transaction(async (tx) => {
        await tx
          .insert(refunds)
          .values({
            id: `ref_${randomUUID()}`,
            applicationId,
            orderId: payment.orderId,
            paymentId: payment.id,
            providerConnectionId: payment.providerConnectionId,
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
          await tx
            .update(orders)
            .set({ status: "refunded", updatedAt: new Date() })
            .where(eq(orders.id, payment.orderId));
          await revokeEntitlementsBySource(
            applicationId,
            "order",
            payment.orderId,
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
