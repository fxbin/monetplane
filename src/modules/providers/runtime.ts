import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { createCreemProviderAdapter } from "./adapters/creem";
import { createPayPalProviderAdapter } from "./adapters/paypal";
import { createWaffoProviderAdapter } from "./adapters/waffo";
import { resolveCheckoutProviderProductIds } from "./catalog-mapping";
import type {
  CancelSubscriptionInput,
  CheckoutBillingMode,
  CreateCatalogProductInput,
  CreateCheckoutInput,
  CreatedCatalogProduct,
  GetCatalogProductInput,
  GetPaymentInput,
  GetSubscriptionInput,
  NormalizedProviderCatalogProduct,
  PaymentProviderAdapter,
  ProviderCapability,
  RefundPaymentInput,
  UpdateSubscriptionInput,
  VerifyWebhookInput,
} from "./contract";
import {
  ProviderApplicationMismatchError,
  ProviderCatalogLookupUnsupportedError,
  ProviderOperationError,
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
          : provider === "paypal"
            ? createPayPalProviderAdapter()
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

  // Catalog mapping precedence (#155): persisted provider_catalog_mappings
  // rows win over the adapters' legacy connection-metadata catalog. With no
  // mapping row the items carry no providerProductId and every adapter
  // behaves exactly as before.
  const providerProductIds = await resolveCheckoutProviderProductIds(
    applicationId,
    connectionId,
    input.items.map((item) => item.priceId),
    db,
  );
  const items = input.items.map((item) => ({
    ...item,
    providerProductId: providerProductIds.get(item.priceId),
  }));

  return adapter.createCheckout(connection, { ...input, items });
}

/**
 * Read-only provider product lookup for the console link flow (#155).
 * Fails closed with a rejected ProviderOperationError when the provider
 * adapter cannot verify existing products.
 */
export async function getProviderCatalogProduct(
  applicationId: string,
  connectionId: string,
  input: GetCatalogProductInput,
  db: Database = getDb(),
): Promise<NormalizedProviderCatalogProduct> {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  if (!adapter.getCatalogProduct) {
    throw new ProviderCatalogLookupUnsupportedError(connection.provider);
  }
  return adapter.getCatalogProduct(connection, input);
}

/**
 * Provider product creation for the provisioning flow (#156). Capability
 * AND implementation gated: a provider that cannot create products fails
 * closed as a deterministic rejection before any state is persisted.
 */
export async function createProviderCatalogProduct(
  applicationId: string,
  connectionId: string,
  input: CreateCatalogProductInput,
  db: Database = getDb(),
): Promise<CreatedCatalogProduct> {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  requireCapability(
    connection.provider,
    adapter.getCapabilities(connection),
    "catalog_provisioning",
  );
  if (!adapter.createCatalogProduct) {
    throw new ProviderOperationError(
      `Provider ${connection.provider} does not support catalog product creation`,
      "rejected",
    );
  }
  return adapter.createCatalogProduct(connection, input);
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

/**
 * Hosted payment-management redirect (#71). Only callable when the adapter
 * implements createCustomerPortalSession AND claims the customer_portal
 * capability — the portal never offers an unsupported action.
 */
export async function createProviderCustomerPortalSession(
  applicationId: string,
  connectionId: string,
  input: { providerCustomerId?: string; returnUrl?: string },
  db: Database = getDb(),
) {
  const connection = await loadProviderConnectionContext(
    applicationId,
    connectionId,
    db,
  );
  const adapter = resolveProviderAdapter(connection.provider);
  const capabilities = adapter.getCapabilities(connection);
  if (!capabilities.customer_portal || !adapter.createCustomerPortalSession) {
    throw new UnsupportedProviderCapabilityError(
      connection.provider,
      "customer_portal",
    );
  }
  return adapter.createCustomerPortalSession(connection, input);
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
