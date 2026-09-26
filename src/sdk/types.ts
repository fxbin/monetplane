/**
 * MonetPlane SDK public types.
 *
 * These types are provider-neutral. Product code uses only these types
 * to interact with MonetPlane—never provider-specific objects.
 */

/**
 * Billing environment plane. Runtime operations are isolated per the
 * environment ADR; omitted environment defaults to "test" during the
 * deprecation window.
 */
export type Environment = "test" | "live";

export type CheckoutInput = {
  externalCustomerId: string;
  items: Array<{ priceId: string; quantity: number }>;
  /**
   * Optional explicit provider override for internal/debug use. Normal
   * checkouts omit this; MonetPlane routes the provider from product and
   * environment configuration.
   */
  providerConnectionId?: string;
  successUrl: string;
  cancelUrl: string;
  environment?: Environment;
};

export type CheckoutResult = {
  orderId: string;
  checkoutSessionId: string;
  checkoutUrl: string;
  providerCheckoutId: string;
  orderStatus: string;
};

export type PortalSessionInput = {
  externalCustomerId: string;
  environment?: Environment;
  /** Optional post-portal return URL; its origin must be a registered callback origin. */
  returnUrl?: string;
};

export type PortalSessionResult = {
  sessionId: string;
  portalUrl: string;
  expiresAt: string;
};

export type CustomerInput = {
  externalCustomerId: string;
  email?: string | null;
  metadata?: Record<string, unknown>;
};

export type CustomerResult = {
  id: string;
  applicationId: string;
  customerId: string;
  externalCustomerId: string;
  email: string | null;
  metadata: Record<string, unknown>;
};

export type CreditBalance = {
  creditType: string;
  available: number;
  reserved: number;
};

export type DebitCreditsInput = {
  externalCustomerId: string;
  creditType: string;
  amount: number;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  environment?: Environment;
};

export type DebitCreditsResult = {
  transactionId: string;
  duplicate: boolean;
  availableAfter: number;
};

export type ReserveCreditsInput = {
  externalCustomerId: string;
  creditType: string;
  amount: number;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
  environment?: Environment;
};

export type ReserveCreditsResult = {
  reservationId: string;
  duplicate: boolean;
};

export type CaptureReservationInput = {
  reservationId: string;
  amount: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  environment?: Environment;
};

export type CaptureReservationResult = {
  transactionId: string;
  duplicate: boolean;
  terminal: boolean;
};

export type ReleaseReservationInput = {
  reservationId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  environment?: Environment;
};

export type ReleaseReservationResult = {
  transactionId: string;
  duplicate: boolean;
};

export type EntitlementCheckInput = {
  externalCustomerId: string;
  featureKey: string;
  at?: Date;
  environment?: Environment;
};

export type EntitlementCheckResult = {
  granted: boolean;
};

export type MonetPlaneClientOptions = {
  /** The base URL of the MonetPlane instance (e.g. https://api.monetplane.com). */
  baseUrl: string;
  /** The application secret (starts with `mp_app_`). Never expose in browser code. */
  appSecret: string;
  /** Optional custom fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Optional request timeout in milliseconds (defaults to 30000). */
  timeoutMs?: number;
};

export type ReportUsageInput = {
  externalCustomerId: string;
  meterKey: string;
  quantity: number;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  environment?: Environment;
};

export type ReportUsageResult = {
  eventId: string;
  duplicate: boolean;
  quantity: number;
  occurredAt: string;
};
