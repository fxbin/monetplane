import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { prices, products } from "../catalog/schema";
import {
  type CatalogMappingRow,
  compareProviderProductWithPrice,
  legacyCatalogProductId,
  verifiedSnapshotFor,
} from "./catalog-mapping";
import type {
  CreateCatalogProductInput,
  NormalizedProviderCatalogProduct,
  ProviderMode,
} from "./contract";
import { providerCatalogMappings } from "./schema";
import { getProviderConnection } from "./service";

/**
 * Catalog provisioning state machine (#156).
 *
 * One mapping row per (application, environment, connection, price) IS the
 * sync intent. Transitions are conditional single-row UPDATEs so exactly
 * one writer can move a row at a time; every external provider call is
 * made by the control-plane orchestration OUTSIDE any transaction, between
 * two deterministic row transitions:
 *
 *   (absent) ──▶ pending ──▶ creating ──┬─▶ synced(product id + snapshot)
 *                                       ├─▶ needs_reconciliation(id?)
 *                                       └─▶ failed(no id)
 *
 * - `needs_reconciliation` is the ONLY parking state for uncertain
 *   outcomes (timeout / 5xx / response lost): the create MAY have landed,
 *   so the same intent is never auto-re-POSTed. Recovery is the audited
 *   link-adoption path in catalog-mapping.ts (operator finds the product
 *   at the provider and links it), or the operator marks intent failed and
 *   retries — both explicit, neither automatic.
 * - `failed` is deterministic rejection (Creem 401/422, pre-flight
 *   violations, exhausted 429): retrying a failed intent is safe and
 *   starts a fresh pending → creating cycle with the SAME idempotency key
 *   (the mapping row id), so a Creem-side retry cannot fork duplicates.
 * - A row stuck in pending/creating past STALE_AFTER_MS is treated as a
 *   crashed attempt and parked into needs_reconciliation by the next
 *   provision attempt (audited by the caller) — the operator then adopts
 *   or fails it; nothing is auto-retried.
 */

export const STALE_IN_FLIGHT_MS = 5 * 60 * 1000;

export type CatalogProvisionErrorCode =
  | "invalid_input"
  | "connection_not_found"
  | "connection_revoked"
  | "connection_environment_mismatch"
  | "price_not_found"
  | "price_inactive"
  | "provider_unsupported"
  | "legacy_mapping_conflict"
  | "provision_in_progress"
  | "provision_needs_attention"
  | "provision_create_rejected"
  | "provision_post_create_mismatch";

export class CatalogProvisionError extends Error {
  constructor(
    message: string,
    public readonly code: CatalogProvisionErrorCode,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CatalogProvisionError";
  }
}

export type ProvisionBeginResult =
  | {
      /** Fresh intent created and moved into `creating`; call the provider now. */
      outcome: "begin";
      mapping: CatalogMappingRow;
      input: CreateCatalogProductInput;
      /** Ownership token for THIS attempt — every finish update must match it. */
      attemptToken: string;
    }
  | {
      /** A synced mapping already exists — read-only, never re-created. */
      outcome: "already_synced";
      mapping: CatalogMappingRow;
    }
  | {
      /** A stale in-flight row was parked as needs_reconciliation. */
      outcome: "stale_parked";
      mapping: CatalogMappingRow;
    };

async function loadOwnedPrice(
  applicationId: string,
  monetplanePriceId: string,
  db: Database,
) {
  const [row] = await db
    .select({ price: prices, product: products })
    .from(prices)
    .innerJoin(products, eq(prices.productId, products.id))
    .where(
      and(
        eq(prices.id, monetplanePriceId),
        eq(products.applicationId, applicationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findMappingRow(
  applicationId: string,
  environment: ProviderMode,
  providerConnectionId: string,
  monetplanePriceId: string,
  db: Database,
): Promise<CatalogMappingRow | null> {
  const [row] = await db
    .select()
    .from(providerCatalogMappings)
    .where(
      and(
        eq(providerCatalogMappings.applicationId, applicationId),
        eq(providerCatalogMappings.environment, environment),
        eq(providerCatalogMappings.providerConnectionId, providerConnectionId),
        eq(providerCatalogMappings.monetplanePriceId, monetplanePriceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function isStale(row: CatalogMappingRow): boolean {
  return Date.now() - row.updatedAt.getTime() > STALE_IN_FLIGHT_MS;
}

/**
 * The provider-visible create parameters of an intent, EXCLUDING the
 * idempotency key (the row id, stable by design). Frozen on first claim:
 * a retry after an uncertain outcome re-sends the same key, so Creem
 * would return the ORIGINALLY created product — a retry with different
 * parameters would silently produce the old product under new intent.
 * Divergent retries are rejected instead (#156 review round 2, F2).
 */
export type CatalogProvisionIntent = Pick<
  CreateCatalogProductInput,
  | "name"
  | "description"
  | "amountMinor"
  | "currency"
  | "billingType"
  | "recurringInterval"
  | "intervalCount"
  | "taxCategory"
>;

function effectiveCreateIntent(
  owned: {
    price: typeof prices.$inferSelect;
    product: typeof products.$inferSelect;
  },
  input: {
    name?: string;
    description?: string | null;
    taxCategory?: string | null;
  },
): CatalogProvisionIntent {
  return {
    name: (input.name?.trim() || owned.product.name).trim(),
    description: input.description?.trim() || owned.product.description || null,
    amountMinor: owned.price.amountMinor,
    currency: owned.price.currency.toUpperCase(),
    billingType:
      owned.price.billingType === "recurring" ? "recurring" : "one_time",
    recurringInterval:
      owned.price.recurringInterval === "week" ||
      owned.price.recurringInterval === "month" ||
      owned.price.recurringInterval === "year"
        ? owned.price.recurringInterval
        : null,
    intervalCount: owned.price.intervalCount,
    taxCategory: input.taxCategory?.trim() || null,
  };
}

const INTENT_SIGNATURE_KEYS: Array<keyof CatalogProvisionIntent> = [
  "name",
  "description",
  "amountMinor",
  "currency",
  "billingType",
  "recurringInterval",
  "intervalCount",
  "taxCategory",
];

function intentSignature(intent: CatalogProvisionIntent) {
  return JSON.stringify(intent, INTENT_SIGNATURE_KEYS);
}

function frozenIntentOf(row: CatalogMappingRow): CatalogProvisionIntent | null {
  const frozen = row.verifiedSnapshot?.provisionIntent;
  if (!frozen || typeof frozen !== "object") return null;
  return frozen as CatalogProvisionIntent;
}

/**
 * Validate the request, resolve the existing row's state, and (when safe)
 * move the intent into `creating`. The returned CreateCatalogProductInput
 * carries the mapping-row-stable idempotency key. All provider validation
 * that needs the adapter (capability, currency, tax enums) happens in the
 * orchestration/runtime BEFORE beginProvision commits a pending row, so
 * pre-flight rejections never leave state behind.
 */
export async function beginProvision(
  input: {
    applicationId: string;
    environment: ProviderMode;
    providerConnectionId: string;
    monetplanePriceId: string;
    name?: string;
    description?: string | null;
    taxCategory?: string | null;
  },
  db: Database = getDb(),
): Promise<ProvisionBeginResult> {
  const connection = await getProviderConnection(
    input.applicationId,
    input.providerConnectionId,
    db,
  );
  if (!connection) {
    throw new CatalogProvisionError(
      "Provider connection not found in the selected project",
      "connection_not_found",
    );
  }
  if (connection.status !== "active") {
    throw new CatalogProvisionError(
      "Provider connection is revoked",
      "connection_revoked",
    );
  }
  if (connection.mode !== input.environment) {
    throw new CatalogProvisionError(
      `Provider connection belongs to the ${connection.mode} environment, not ${input.environment}`,
      "connection_environment_mismatch",
      {
        connectionMode: connection.mode,
        requestedEnvironment: input.environment,
      },
    );
  }

  const owned = await loadOwnedPrice(
    input.applicationId,
    input.monetplanePriceId,
    db,
  );
  if (!owned) {
    throw new CatalogProvisionError(
      "MonetPlane price not found in the selected project",
      "price_not_found",
    );
  }
  if (owned.price.status !== "active") {
    throw new CatalogProvisionError(
      "MonetPlane price is archived and cannot be provisioned",
      "price_inactive",
    );
  }

  // A legacy metadata mapping means the price already points at a provider
  // product; auto-creating another one would fork the catalog and silently
  // switch checkout to the new product. Fail closed; use link instead.
  const legacyId = legacyCatalogProductId(connection, input.monetplanePriceId);
  if (legacyId) {
    throw new CatalogProvisionError(
      "This price already has a legacy metadata mapping; link that product instead of creating a new one",
      "legacy_mapping_conflict",
      { legacyProviderProductId: legacyId },
    );
  }

  const existing = await findMappingRow(
    input.applicationId,
    input.environment,
    input.providerConnectionId,
    input.monetplanePriceId,
    db,
  );

  if (existing) {
    if (existing.status === "synced") {
      return { outcome: "already_synced", mapping: existing };
    }
    // F2: retries re-send the same idempotency key, so the provider would
    // return the originally created product — the intent parameters are
    // frozen at first claim and divergent retries are rejected.
    const frozenIntent = frozenIntentOf(existing);
    if (frozenIntent) {
      const currentIntent = effectiveCreateIntent(owned, input);
      if (intentSignature(currentIntent) !== intentSignature(frozenIntent)) {
        throw new CatalogProvisionError(
          "The create parameters differ from the original attempt for this intent; the provider may already hold a product created with the original parameters. Recover via link, or use a new price",
          "invalid_input",
          { frozenIntent },
        );
      }
    }
    if (existing.status === "pending" || existing.status === "creating") {
      if (isStale(existing)) {
        // Crashed attempt: park it for manual recovery. Conditional update
        // keeps a concurrent writer (if any) authoritative.
        const [parked] = await db
          .update(providerCatalogMappings)
          .set({ status: "needs_reconciliation", updatedAt: new Date() })
          .where(
            and(
              eq(providerCatalogMappings.id, existing.id),
              eq(providerCatalogMappings.status, existing.status),
              // Compare-and-swap on the observed version: an attempt that
              // made progress since the staleness read (e.g. persisted its
              // created product id, refreshing updated_at) must not be
              // parked from a stale observation (#156 review round 3, F1b).
              eq(providerCatalogMappings.updatedAt, existing.updatedAt),
            ),
          )
          .returning();
        if (parked) {
          return { outcome: "stale_parked", mapping: parked };
        }
        // Lost the race: re-read and fall through to the fresh rules.
        return beginProvision(input, db);
      }
      throw new CatalogProvisionError(
        "A provisioning attempt for this price is already in progress",
        "provision_in_progress",
        { existingStatus: existing.status },
      );
    }
    if (existing.status === "needs_reconciliation") {
      throw new CatalogProvisionError(
        "A previous create attempt has an uncertain outcome (the product may already exist at the provider). Find the product there and link it to adopt it, or mark the intent failed before retrying",
        "provision_needs_attention",
        { existingStatus: existing.status },
      );
    }
    // failed: explicit retry — reuse the row (and its stable idempotency
    // key) by moving it back to pending and claiming it below.
    const [reset] = await db
      .update(providerCatalogMappings)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(providerCatalogMappings.id, existing.id),
          eq(providerCatalogMappings.status, "failed"),
        ),
      )
      .returning();
    if (!reset) {
      return beginProvision(input, db);
    }
    return claimPendingIntent(reset, owned, input, db);
  }

  const [pendingRow] = await db
    .insert(providerCatalogMappings)
    .values({
      id: `pcmap_${randomUUID()}`,
      applicationId: input.applicationId,
      providerConnectionId: input.providerConnectionId,
      environment: input.environment,
      monetplanePriceId: input.monetplanePriceId,
      provider: connection.provider,
      providerProductId: null,
      source: "created",
      status: "pending",
      verifiedSnapshot: {
        provisionIntent: effectiveCreateIntent(owned, input),
      },
    })
    .onConflictDoNothing({
      target: [
        providerCatalogMappings.applicationId,
        providerCatalogMappings.environment,
        providerCatalogMappings.providerConnectionId,
        providerCatalogMappings.monetplanePriceId,
      ],
    })
    .returning();

  if (!pendingRow) {
    // A concurrent request created the intent first: only one may proceed.
    const raced = await findMappingRow(
      input.applicationId,
      input.environment,
      input.providerConnectionId,
      input.monetplanePriceId,
      db,
    );
    if (!raced || raced.status === "pending" || raced.status === "creating") {
      throw new CatalogProvisionError(
        "A provisioning attempt for this price is already in progress",
        "provision_in_progress",
        { existingStatus: raced?.status ?? null },
      );
    }
    if (raced.status === "synced") {
      return { outcome: "already_synced", mapping: raced };
    }
    throw new CatalogProvisionError(
      raced.status === "needs_reconciliation"
        ? "A previous create attempt has an uncertain outcome (the product may already exist at the provider). Find the product there and link it to adopt it, or mark the intent failed before retrying"
        : "Retry the provisioning request",
      raced.status === "needs_reconciliation"
        ? "provision_needs_attention"
        : "provision_in_progress",
      { existingStatus: raced.status },
    );
  }

  return claimPendingIntent(pendingRow, owned, input, db);
}

/**
 * Move a just-owned `pending` row into `creating` and build the provider
 * create input with the row-stable idempotency key. Shared by the fresh
 * insert and the failed→retry paths.
 */
async function claimPendingIntent(
  pendingRow: CatalogMappingRow,
  owned: {
    price: typeof prices.$inferSelect;
    product: typeof products.$inferSelect;
  },
  input: {
    name?: string;
    description?: string | null;
    taxCategory?: string | null;
  },
  db: Database,
): Promise<ProvisionBeginResult> {
  // pending → creating: the conditional update guarantees single ownership
  // of the external call, and the fresh attempt token marks WHO owns every
  // subsequent write (ABA guard, review round 2 F1).
  const attemptToken = `pcatk_${randomUUID()}`;
  const [creatingRow] = await db
    .update(providerCatalogMappings)
    .set({ status: "creating", attemptToken, updatedAt: new Date() })
    .where(
      and(
        eq(providerCatalogMappings.id, pendingRow.id),
        eq(providerCatalogMappings.status, "pending"),
      ),
    )
    .returning();
  if (!creatingRow) {
    throw new CatalogProvisionError(
      "A provisioning attempt for this price is already in progress",
      "provision_in_progress",
    );
  }

  const createInput: CreateCatalogProductInput = {
    ...effectiveCreateIntent(owned, input),
    // Stable across retries of this intent — Creem's documented
    // Idempotency-Key dedupes a re-sent create to the original product.
    idempotencyKey: creatingRow.id,
  };

  return {
    outcome: "begin",
    mapping: creatingRow,
    input: createInput,
    attemptToken,
  };
}

export type ProvisionFinishResult = {
  outcome: "synced" | "uncertain" | "failed";
  mapping: CatalogMappingRow;
};

/**
 * Complete a `begin` attempt after the external call:
 * - success + re-read product matches the price → synced
 * - success but the re-read mismatches → needs_reconciliation (with the
 *   created id — a wrong product exists and needs a human)
 * - deterministic rejection → failed
 * - uncertain outcome (timeout/5xx/network) → needs_reconciliation
 *   WITHOUT an id; recovery is adoption or explicit fail-then-retry.
 * `cause` classification mirrors classifyProviderOperationFailure.
 */
export async function finishProvision(
  input: {
    applicationId: string;
    environment: ProviderMode;
    providerConnectionId: string;
    monetplanePriceId: string;
    mappingId: string;
    /** Ownership token issued by the matching beginProvision claim. */
    attemptToken: string;
  },
  result:
    | { kind: "created"; providerProductId: string }
    | { kind: "rejected"; message: string }
    | { kind: "uncertain"; message: string },
  verify: (
    providerProductId: string,
  ) => Promise<NormalizedProviderCatalogProduct>,
  db: Database = getDb(),
): Promise<ProvisionFinishResult> {
  const owned = await loadOwnedPrice(
    input.applicationId,
    input.monetplanePriceId,
    db,
  );
  if (!owned) {
    throw new CatalogProvisionError(
      "MonetPlane price not found in the selected project",
      "price_not_found",
    );
  }

  const now = new Date();

  if (result.kind === "rejected") {
    const [mapping] = await db
      .update(providerCatalogMappings)
      .set({ status: "failed", updatedAt: now })
      .where(
        and(
          eq(providerCatalogMappings.id, input.mappingId),
          inArray(providerCatalogMappings.status, [
            "creating",
            "needs_reconciliation",
          ]),
          eq(providerCatalogMappings.attemptToken, input.attemptToken),
        ),
      )
      .returning();
    if (!mapping) {
      throw new CatalogProvisionError(
        "Provisioning intent is no longer in the creating state",
        "provision_needs_attention",
      );
    }
    return { outcome: "failed", mapping };
  }

  if (result.kind === "uncertain") {
    // The create MAY have landed — park without an id; never auto-retry.
    const [mapping] = await db
      .update(providerCatalogMappings)
      .set({ status: "needs_reconciliation", updatedAt: now })
      .where(
        and(
          eq(providerCatalogMappings.id, input.mappingId),
          inArray(providerCatalogMappings.status, [
            "creating",
            "needs_reconciliation",
          ]),
          eq(providerCatalogMappings.attemptToken, input.attemptToken),
        ),
      )
      .returning();
    if (!mapping) {
      throw new CatalogProvisionError(
        "Provisioning intent is no longer in the creating state",
        "provision_needs_attention",
      );
    }
    return { outcome: "uncertain", mapping };
  }

  // Created: persist the id on the creating row IMMEDIATELY (before the
  // verification read) so a concurrent stale-park can never discard it —
  // a row already parked as needs_reconciliation still receives the id.
  const persistCreatedId = async (): Promise<boolean> => {
    const [row] = await db
      .update(providerCatalogMappings)
      .set({ providerProductId: result.providerProductId, updatedAt: now })
      .where(
        and(
          eq(providerCatalogMappings.id, input.mappingId),
          inArray(providerCatalogMappings.status, [
            "creating",
            "needs_reconciliation",
          ]),
          eq(providerCatalogMappings.attemptToken, input.attemptToken),
        ),
      )
      .returning();
    return Boolean(row);
  };
  if (!(await persistCreatedId())) {
    throw new CatalogProvisionError(
      "Provisioning intent is no longer in a state that accepts the created product id",
      "provision_needs_attention",
    );
  }

  // Bidirectional verification — re-read the product and compare against
  // the MonetPlane price before declaring success (#156 §4).
  let product: NormalizedProviderCatalogProduct;
  try {
    product = await verify(result.providerProductId);
    if (product.providerProductId !== result.providerProductId) {
      throw new Error(
        `Provider returned product ${product.providerProductId} for id ${result.providerProductId}`,
      );
    }
  } catch {
    // The create response carried an id but the verification read failed:
    // treat as uncertain WITH the id so recovery can adopt it directly.
    const [mapping] = await db
      .update(providerCatalogMappings)
      .set({
        status: "needs_reconciliation",
        providerProductId: result.providerProductId,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerCatalogMappings.id, input.mappingId),
          inArray(providerCatalogMappings.status, [
            "creating",
            "needs_reconciliation",
          ]),
          eq(providerCatalogMappings.attemptToken, input.attemptToken),
        ),
      )
      .returning();
    if (!mapping) {
      throw new CatalogProvisionError(
        "Provisioning intent is no longer in the creating state",
        "provision_needs_attention",
      );
    }
    return { outcome: "uncertain", mapping };
  }

  const mismatches = compareProviderProductWithPrice(
    owned.price,
    product,
    input.environment,
  );
  if (mismatches.length > 0) {
    const [mapping] = await db
      .update(providerCatalogMappings)
      .set({
        status: "needs_reconciliation",
        providerProductId: result.providerProductId,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerCatalogMappings.id, input.mappingId),
          inArray(providerCatalogMappings.status, [
            "creating",
            "needs_reconciliation",
          ]),
          eq(providerCatalogMappings.attemptToken, input.attemptToken),
        ),
      )
      .returning();
    if (!mapping) {
      throw new CatalogProvisionError(
        "Provisioning intent is no longer in the creating state",
        "provision_needs_attention",
      );
    }
    throw new CatalogProvisionError(
      "The provider created a product that does not match this price; parked for manual reconciliation",
      "provision_post_create_mismatch",
      { mismatches, providerProductId: result.providerProductId },
    );
  }

  const [mapping] = await db
    .update(providerCatalogMappings)
    .set({
      status: "synced",
      providerProductId: result.providerProductId,
      verifiedSnapshot: verifiedSnapshotFor(owned.price, product),
      lastVerifiedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerCatalogMappings.id, input.mappingId),
        inArray(providerCatalogMappings.status, [
          "creating",
          "needs_reconciliation",
        ]),
        eq(providerCatalogMappings.attemptToken, input.attemptToken),
      ),
    )
    .returning();
  if (!mapping) {
    throw new CatalogProvisionError(
      "Provisioning intent is no longer in the creating state",
      "provision_needs_attention",
    );
  }
  return { outcome: "synced", mapping };
}

/**
 * Explicit operator action: park a needs_reconciliation intent as failed so
 * it can be retried (audited by the caller). Refuses on any other state.
 */
export async function failNeedsReconciliationIntent(
  input: {
    applicationId: string;
    environment: ProviderMode;
    providerConnectionId: string;
    monetplanePriceId: string;
  },
  db: Database = getDb(),
): Promise<CatalogMappingRow> {
  const existing = await findMappingRow(
    input.applicationId,
    input.environment,
    input.providerConnectionId,
    input.monetplanePriceId,
    db,
  );
  if (!existing || existing.status !== "needs_reconciliation") {
    throw new CatalogProvisionError(
      "Only a needs-reconciliation intent can be marked failed",
      "provision_needs_attention",
      { existingStatus: existing?.status ?? null },
    );
  }
  const [row] = await db
    .update(providerCatalogMappings)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(providerCatalogMappings.id, existing.id),
        eq(providerCatalogMappings.status, "needs_reconciliation"),
      ),
    )
    .returning();
  if (!row) {
    throw new CatalogProvisionError(
      "Only a needs-reconciliation intent can be marked failed",
      "provision_needs_attention",
    );
  }
  return row;
}
