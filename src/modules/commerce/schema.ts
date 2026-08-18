import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { applications } from "../applications/schema";
import { prices, products } from "../catalog/schema";
import { applicationCustomers, customers } from "../customers/schema";
import { providerConnections } from "../providers/schema";

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    applicationCustomerId: text("application_customer_id")
      .notNull()
      .references(() => applicationCustomers.id, { onDelete: "restrict" }),
    billingMode: text("billing_mode").notNull(),
    status: text("status").default("pending").notNull(),
    currency: text("currency").notNull(),
    totalAmountMinor: bigint("total_amount_minor", {
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("orders_application_idx").on(table.applicationId),
    index("orders_customer_idx").on(table.applicationCustomerId),
    check(
      "orders_billing_mode_check",
      sql`${table.billingMode} IN ('one_time', 'subscription')`,
    ),
    check(
      "orders_status_check",
      sql`${table.status} IN ('pending', 'paid', 'failed', 'refunded')`,
    ),
    check(
      "orders_total_nonnegative_check",
      sql`${table.totalAmountMinor} >= 0`,
    ),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    priceId: text("price_id")
      .notNull()
      .references(() => prices.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("order_items_order_idx").on(table.orderId),
    check("order_items_quantity_check", sql`${table.quantity} > 0`),
    check("order_items_amount_check", sql`${table.unitAmountMinor} >= 0`),
  ],
);

export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "restrict" }),
    status: text("status").default("creating").notNull(),
    providerCheckoutId: text("provider_checkout_id"),
    checkoutUrl: text("checkout_url"),
    successUrl: text("success_url").notNull(),
    cancelUrl: text("cancel_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("checkout_sessions_application_idx").on(table.applicationId),
    index("checkout_sessions_order_idx").on(table.orderId),
    uniqueIndex("checkout_sessions_provider_checkout_unique").on(
      table.providerConnectionId,
      table.providerCheckoutId,
    ),
    check(
      "checkout_sessions_status_check",
      sql`${table.status} IN ('creating', 'open', 'completed', 'failed', 'expired')`,
    ),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "restrict" }),
    providerPaymentId: text("provider_payment_id").notNull(),
    status: text("status").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payments_provider_payment_unique").on(
      table.providerConnectionId,
      table.providerPaymentId,
    ),
    index("payments_application_idx").on(table.applicationId),
    index("payments_order_idx").on(table.orderId),
    check(
      "payments_status_check",
      sql`${table.status} IN ('pending', 'succeeded', 'failed', 'refunded')`,
    ),
    check("payments_amount_check", sql`${table.amountMinor} >= 0`),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "restrict" }),
    providerRefundId: text("provider_refund_id").notNull(),
    status: text("status").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("refunds_provider_refund_unique").on(
      table.providerConnectionId,
      table.providerRefundId,
    ),
    index("refunds_application_idx").on(table.applicationId),
    index("refunds_payment_idx").on(table.paymentId),
    check(
      "refunds_status_check",
      sql`${table.status} IN ('pending', 'succeeded', 'failed')`,
    ),
    check(
      "refunds_amount_check",
      sql`${table.amountMinor} IS NULL OR ${table.amountMinor} >= 0`,
    ),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    applicationCustomerId: text("application_customer_id")
      .notNull()
      .references(() => applicationCustomers.id, { onDelete: "restrict" }),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "restrict" }),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    status: text("status").notNull(),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("subscriptions_provider_subscription_unique").on(
      table.providerConnectionId,
      table.providerSubscriptionId,
    ),
    index("subscriptions_application_idx").on(table.applicationId),
    index("subscriptions_customer_idx").on(table.applicationCustomerId),
    check(
      "subscriptions_status_check",
      sql`${table.status} IN ('pending', 'active', 'past_due', 'cancelled', 'expired')`,
    ),
  ],
);

export const subscriptionItems = pgTable(
  "subscription_items",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    priceId: text("price_id")
      .notNull()
      .references(() => prices.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("subscription_items_subscription_price_unique").on(
      table.subscriptionId,
      table.priceId,
    ),
    index("subscription_items_subscription_idx").on(table.subscriptionId),
    check("subscription_items_quantity_check", sql`${table.quantity} > 0`),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "restrict" }),
    providerEventId: text("provider_event_id").notNull(),
    providerEventName: text("provider_event_name").notNull(),
    normalizedType: text("normalized_type").notNull(),
    status: text("status").default("received").notNull(),
    rawBody: text("raw_body").notNull(),
    normalizedEvent: jsonb("normalized_event")
      .$type<Record<string, unknown>>()
      .notNull(),
    errorMessage: text("error_message"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("webhook_events_provider_event_unique").on(
      table.providerConnectionId,
      table.providerEventId,
    ),
    index("webhook_events_application_idx").on(table.applicationId),
    index("webhook_events_status_idx").on(table.status),
    check(
      "webhook_events_status_check",
      sql`${table.status} IN ('received', 'processed', 'ignored', 'failed')`,
    ),
  ],
);
