import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { createCreemProviderAdapter } from "./adapters/creem";
import { createWaffoProviderAdapter } from "./adapters/waffo";
import type {
  CancelSubscriptionInput,
  CheckoutBillingMode,
  CreateCheckoutInput,
  GetPaymentInput,
  GetSubscriptionInput,
  PaymentProviderAdapter,
  ProviderCapability,
  RefundPaymentInput,
  UpdateSubscriptionInput,
  VerifyWebhookInput,
} from "./contract";
import {
  ProviderApplicationMismatchError,
  UnsupportedProviderCapabilityError,
} from "./contract";
import {
  getProviderAdapter,
  ProviderAdapterNotRegisteredError,
  registerProviderAdapter,
} from "./registry";
import { loadProviderConnectionContext } from "./service";

function requireCapability(
  provider: string,
  capabilities: Readonly<Record<ProviderCapability, boolean>>,
  capability: ProviderCapability,
): void {
  if (!capabilities[capability]) {
    throw new UnsupportedProviderCapabilityError(provider, capability);
  }
}

function checkoutCapability(mode: CheckoutBillingMode): ProviderCapability {
  return mode === "one_time" ? "one_time_checkout" : "recurring_subscription";
}

function resolveProviderAdapter(provider: string): PaymentProviderAdapter {
  try {
    return getProviderAdapter(provider);
  } catch (error) {
    if (!(error instanceof ProviderAdapterNotRegisteredError)) throw error;

    const adapter =
      provider === "creem"
        ? createCreemProviderAdapter()
        : provider === "waffo"
          ? createWaffoProviderAdapter()
          : null;
    if (!adapter) throw error;

    registerProviderAdapter(adapter);
    return adapter;
  }
}

export async function getProviderCapabilities(
  applicationId: string,
  connectionId: string,
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  return resolveProviderAdapter(connection.provider).getCapabilities(
    connection,
  );
}

export async function validateProviderConnection(
  applicationId: string,
  connectionId: string,
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  if (adapter.validateConnection) {
    return adapter.validateConnection(connection);
  }
  const capabilities = adapter.getCapabilities(connection);
  return {
    summary: `Runtime adapter resolved and encrypted credentials loaded. ${Object.values(capabilities).filter(Boolean).length} capabilities are enabled.`,
  };
}

export async function createProviderCheckout(
  applicationId: string,
  connectionId: string,
  input: CreateCheckoutInput,
  db: Database = getDb(),
) {
  if (input.applicationId !== applicationId) {
    throw new ProviderApplicationMismatchError();
  }

  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  const capabilities = adapter.getCapabilities(connection);

  requireCapability(
    connection.provider,
    capabilities,
    checkoutCapability(input.billingMode),
  );

  if (input.billingMode === "subscription" && input.interval) {
    requireCapability(
      connection.provider,
      capabilities,
      input.interval === "month" ? "monthly_interval" : "annual_interval",
    );
  }

  return adapter.createCheckout(connection, input);
}

export async function getProviderPayment(
  applicationId: string,
  connectionId: string,
  input: GetPaymentInput,
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  return resolveProviderAdapter(connection.provider).getPayment(
    connection,
    input,
  );
}

export async function getProviderSubscription(
  applicationId: string,
  connectionId: string,
  input: GetSubscriptionInput,
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  return resolveProviderAdapter(connection.provider).getSubscription(
    connection,
    input,
  );
}

export async function cancelProviderSubscription(
  applicationId: string,
  connectionId: string,
  input: CancelSubscriptionInput,
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  requireCapability(
    connection.provider,
    adapter.getCapabilities(connection),
    "subscription_cancel",
  );
  return adapter.cancelSubscription(connection, input);
}

export async function updateProviderSubscription(
  applicationId: string,
  connectionId: string,
  input: UpdateSubscriptionInput,
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  requireCapability(
    connection.provider,
    adapter.getCapabilities(connection),
    "subscription_update",
  );
  return adapter.updateSubscription(connection, input);
}

export async function refundProviderPayment(
  applicationId: string,
  connectionId: string,
  input: RefundPaymentInput,
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  requireCapability(
    connection.provider,
    adapter.getCapabilities(connection),
    "refund",
  );
  return adapter.refundPayment(connection, input);
}

export async function verifyAndNormalizeProviderWebhook(
  applicationId: string,
  connectionId: string,
  input: VerifyWebhookInput,
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  const verified = await adapter.verifyWebhook(connection, input);
  return adapter.normalizeWebhook(connection, verified);
}
