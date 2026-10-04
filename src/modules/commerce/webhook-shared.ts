import type { Database } from "../../db/client";
import type { NormalizedProviderEvent } from "../providers/contract";

/**
 * Shared kernel for the provider-webhook processing pipeline (roundtable
 * batch 2 split). The inbox shell lives in webhook.ts; the payment and
 * subscription event families live in webhook-payment-events.ts and
 * webhook-subscription-events.ts. This module holds the pieces they share
 * so no handler imports the orchestrator (no cycles).
 */

export class InvalidNormalizedCommerceEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNormalizedCommerceEventError";
  }
}

export function parseEventDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidNormalizedCommerceEventError(
      "Invalid provider event date",
    );
  }
  return date;
}

/** Minimal transaction surface the event handlers rely on. */
export type WebhookTx = Pick<
  Database,
  "select" | "insert" | "update" | "execute"
>;

export type OrderSnapshot = {
  id: string;
  applicationCustomerId: string;
  billingMode: string;
  status: string;
  currency: string;
  totalAmountMinor: number;
};

export type CustomerSnapshot = { id: string; customerId: string };

/**
 * Everything an event handler needs. `order` and `mappedApplicationCustomer`
 * start as pre-lock snapshots resolved by the inbox shell; the payment
 * handler re-reads them under the payment advisory lock and writes the
 * locked values back, because a subscription.* event following a payment
 * event for the same delivery must observe the locked state (a
 * payment.succeeded for a subscription IS followed by the subscription
 * branch in the same transaction).
 */
export type WebhookProcessingContext = {
  tx: WebhookTx;
  applicationId: string;
  providerConnectionId: string;
  environment: "test" | "live";
  webhookEventId: string;
  event: NormalizedProviderEvent;
  occurredAt: Date;
  /** Whether THIS delivery created the inbox row (drives `duplicate`). */
  inserted: boolean;
  order: OrderSnapshot | undefined;
  mappedApplicationCustomer: CustomerSnapshot | undefined;
};

export type WebhookEventOutcome = {
  webhookEventId: string;
  duplicate: boolean;
  status: "processed" | "ignored";
  normalizedType: string;
};
