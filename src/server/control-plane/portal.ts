import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { products } from "@/modules/catalog/schema";
import {
  orders,
  payments,
  refunds,
  subscriptionItems,
  subscriptions,
} from "@/modules/commerce/schema";
import { creditAccounts } from "@/modules/credits/schema";
import { entitlementGrants } from "@/modules/entitlements/schema";
import {
  PortalServiceError,
  type PortalSessionContext,
  resolvePortalSession,
} from "@/modules/portal/service";
import { UnsupportedProviderCapabilityError } from "@/modules/providers/contract";
import {
  createProviderCustomerPortalSession,
  getProviderCapabilities,
} from "@/modules/providers/runtime";
import { providerConnections } from "@/modules/providers/schema";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { cancelSubscriptionWithJournal } from "@/server/control-plane/billing-operation-actions";

/**
 * Hosted customer billing portal — provider-neutral read model and safe
 * self-service actions (#71).
 *
 * Every lookup is scoped by the portal session (application + application
 * customer + environment); the browser only ever supplies the opaque token.
 * Actions reuse the console billing-operation journal so lifecycle effects
 * (entitlement revocation, provider calls, reconciliation) are identical to
 * operator actions, and are audited with actor_type customer_portal.
 */

export type PortalSubscriptionView = {
  id: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canCancel: boolean;
  items: Array<{
    productName: string;
    quantity: number;
    unitAmountMinor: number;
    currency: string;
    recurringInterval: string | null;
  }>;
};

export type PortalBillingState = {
  session: {
    expiresAt: string;
    returnUrl: string | null;
    environment: PortalSessionContext["environment"];
  };
  branding: PortalSessionContext["branding"];
  customer: PortalSessionContext["customer"];
  subscriptions: PortalSubscriptionView[];
  payments: Array<{
    id: string;
    amountMinor: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  refunds: Array<{
    id: string;
    amountMinor: number | null;
    status: string;
    createdAt: string;
  }>;
  entitlements: Array<{ featureKey: string; createdAt: string }>;
  credits: Array<{
    creditType: string;
    availableBalance: number;
    reservedBalance: number;
  }>;
  capabilities: {
    /** Provider-homed payment management redirect (customer_portal). */
    paymentManagement: boolean;
  };
};

async function resolveActiveConnection(
  applicationId: string,
  environment: "test" | "live",
  preferredConnectionId?: string,
): Promise<{ id: string; provider: string } | null> {
  const db = getDb();
  if (preferredConnectionId) {
    const [preferred] = await db
      .select({
        id: providerConnections.id,
        provider: providerConnections.provider,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, preferredConnectionId),
          eq(providerConnections.applicationId, applicationId),
          eq(providerConnections.mode, environment),
          eq(providerConnections.status, "active"),
        ),
      )
      .limit(1);
    if (preferred) return preferred;
  }
  const [any] = await db
    .select({
      id: providerConnections.id,
      provider: providerConnections.provider,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.applicationId, applicationId),
        eq(providerConnections.mode, environment),
        eq(providerConnections.status, "active"),
      ),
    )
    .limit(1);
  return any ?? null;
}

export async function getPortalBillingState(
  token: string,
): Promise<PortalBillingState> {
  const session = await resolvePortalSession(token);
  const db = getDb();

  const subscriptionRows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.applicationId, session.applicationId),
        eq(subscriptions.applicationCustomerId, session.applicationCustomerId),
        eq(subscriptions.environment, session.environment),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(10);

  const items = subscriptionRows.length
    ? await db
        .select({
          subscriptionId: subscriptionItems.subscriptionId,
          productName: products.name,
          quantity: subscriptionItems.quantity,
          unitAmountMinor: subscriptionItems.unitAmountMinor,
          currency: subscriptionItems.currency,
          recurringInterval: subscriptionItems.recurringInterval,
        })
        .from(subscriptionItems)
        .innerJoin(products, eq(subscriptionItems.productId, products.id))
        .where(
          inArray(
            subscriptionItems.subscriptionId,
            subscriptionRows.map((s) => s.id),
          ),
        )
    : [];
  const itemsBySubscription = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsBySubscription.get(item.subscriptionId) ?? [];
    list.push(item);
    itemsBySubscription.set(item.subscriptionId, list);
  }

  const subscriptionViews: PortalSubscriptionView[] = [];
  for (const subscription of subscriptionRows) {
    const cancellable =
      subscription.status === "active" || subscription.status === "past_due";
    let canCancel = false;
    if (cancellable && !subscription.cancelAtPeriodEnd) {
      try {
        const capabilities = await getProviderCapabilities(
          session.applicationId,
          subscription.providerConnectionId,
        );
        canCancel = capabilities.subscription_cancel;
      } catch {
        canCancel = false;
      }
    }
    subscriptionViews.push({
      id: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodStart:
        subscription.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      canCancel,
      items: itemsBySubscription.get(subscription.id) ?? [],
    });
  }

  const orderRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.applicationId, session.applicationId),
        eq(orders.applicationCustomerId, session.applicationCustomerId),
        eq(orders.environment, session.environment),
      ),
    )
    .limit(200);

  const orderIds = orderRows.map((order) => order.id);
  const paymentRows = orderIds.length
    ? await db
        .select()
        .from(payments)
        .where(
          and(
            inArray(payments.orderId, orderIds),
            eq(payments.environment, session.environment),
          ),
        )
        .orderBy(desc(payments.createdAt))
        .limit(20)
    : [];
  const refundRows = paymentRows.length
    ? await db
        .select()
        .from(refunds)
        .where(
          and(
            inArray(
              refunds.paymentId,
              paymentRows.map((payment) => payment.id),
            ),
            eq(refunds.environment, session.environment),
          ),
        )
        .orderBy(desc(refunds.createdAt))
        .limit(20)
    : [];

  const entitlementRows = await db
    .select({
      featureKey: entitlementGrants.featureKey,
      createdAt: entitlementGrants.createdAt,
    })
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.applicationId, session.applicationId),
        eq(
          entitlementGrants.applicationCustomerId,
          session.applicationCustomerId,
        ),
        eq(entitlementGrants.environment, session.environment),
        eq(entitlementGrants.status, "active"),
      ),
    )
    .orderBy(desc(entitlementGrants.createdAt))
    .limit(50);

  const creditRows = await db
    .select()
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.applicationId, session.applicationId),
        eq(creditAccounts.applicationCustomerId, session.applicationCustomerId),
        eq(creditAccounts.environment, session.environment),
      ),
    );

  const latestActive = subscriptionRows.find(
    (subscription) =>
      subscription.status === "active" || subscription.status === "past_due",
  );
  const connection = await resolveActiveConnection(
    session.applicationId,
    session.environment,
    latestActive?.providerConnectionId,
  );
  let paymentManagement = false;
  if (connection) {
    try {
      const capabilities = await getProviderCapabilities(
        session.applicationId,
        connection.id,
      );
      paymentManagement = capabilities.customer_portal;
    } catch {
      paymentManagement = false;
    }
  }

  return {
    session: {
      expiresAt: session.expiresAt.toISOString(),
      returnUrl: session.returnUrl,
      environment: session.environment,
    },
    branding: session.branding,
    customer: session.customer,
    subscriptions: subscriptionViews,
    payments: paymentRows.map((payment) => ({
      id: payment.id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: payment.status,
      createdAt: payment.createdAt.toISOString(),
    })),
    refunds: refundRows.map((refund) => ({
      id: refund.id,
      amountMinor: refund.amountMinor,
      status: refund.status,
      createdAt: refund.createdAt.toISOString(),
    })),
    entitlements: entitlementRows.map((grant) => ({
      featureKey: grant.featureKey,
      createdAt: grant.createdAt.toISOString(),
    })),
    credits: creditRows.map((account) => ({
      creditType: account.creditType,
      availableBalance: account.availableBalance,
      reservedBalance: account.reservedBalance,
    })),
    capabilities: { paymentManagement },
  };
}

/**
 * Immediate cancellation through the shared billing-operation journal.
 * Cross-customer attempts fail closed: the subscription must belong to the
 * session's own application customer.
 */
export async function cancelSubscriptionFromPortal(
  token: string,
  subscriptionId: string,
  request?: Request,
) {
  const session = await resolvePortalSession(token);
  const db = getDb();

  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.applicationId, session.applicationId),
        eq(subscriptions.environment, session.environment),
      ),
    )
    .limit(1);

  if (
    !subscription ||
    subscription.applicationCustomerId !== session.applicationCustomerId
  ) {
    throw new PortalServiceError(
      "Subscription not found for this customer",
      404,
      "not_found",
    );
  }

  const capabilities = await getProviderCapabilities(
    session.applicationId,
    subscription.providerConnectionId,
  );
  if (!capabilities.subscription_cancel) {
    throw new UnsupportedProviderCapabilityError(
      "provider",
      "subscription_cancel",
    );
  }

  const operation = await cancelSubscriptionWithJournal(
    session.applicationId,
    subscription.id,
    session.environment,
  );

  await recordAuditEntry({
    applicationId: session.applicationId,
    environment: session.environment,
    action: "portal.subscription_cancelled",
    resourceType: "billing_operation",
    resourceId: operation.id,
    metadata: {
      subscriptionId: subscription.id,
      portalSessionId: session.sessionId,
      externalCustomerId: session.customer.externalCustomerId,
    },
    request,
    actorType: "customer_portal",
    actor: { id: session.sessionId, label: session.customer.email },
  });

  return operation;
}

/** Provider-homed payment management redirect (capability-gated, audited). */
export async function createPortalPaymentManagementRedirect(
  token: string,
  request?: Request,
): Promise<{ url: string }> {
  const session = await resolvePortalSession(token);
  const db = getDb();

  const latestSubscription = await db
    .select({ providerConnectionId: subscriptions.providerConnectionId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.applicationId, session.applicationId),
        eq(subscriptions.applicationCustomerId, session.applicationCustomerId),
        eq(subscriptions.environment, session.environment),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  const connection = await resolveActiveConnection(
    session.applicationId,
    session.environment,
    latestSubscription[0]?.providerConnectionId,
  );
  if (!connection) {
    throw new PortalServiceError(
      "No payment provider is connected for this application",
      409,
      "no_provider_connection",
    );
  }

  let url: string;
  try {
    const result = await createProviderCustomerPortalSession(
      session.applicationId,
      connection.id,
      { returnUrl: session.returnUrl ?? undefined },
    );
    url = result.url;
  } catch (error) {
    if (error instanceof UnsupportedProviderCapabilityError) {
      throw new PortalServiceError(
        "The connected payment provider does not support payment management",
        409,
        "capability_unsupported",
      );
    }
    throw error;
  }

  await recordAuditEntry({
    applicationId: session.applicationId,
    environment: session.environment,
    action: "portal.payment_management_opened",
    resourceType: "portal_session",
    resourceId: session.sessionId,
    metadata: {
      providerConnectionId: connection.id,
      externalCustomerId: session.customer.externalCustomerId,
    },
    request,
    actorType: "customer_portal",
    actor: { id: session.sessionId, label: session.customer.email },
  });

  return { url };
}
