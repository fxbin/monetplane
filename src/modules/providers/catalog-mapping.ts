import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { prices, products } from "../catalog/schema";
import type {
  NormalizedProviderCatalogProduct,
  ProviderMode,
} from "./contract";
import { providerCatalogMappings } from "./schema";
import { getProviderConnection, type ProviderConnectionView } from "./service";

/**
 * Price-level provider catalog mapping domain service (#155).
 *
 * The link write is a single guarded INSERT: uniqueness comes from the
 * provider_catalog_mappings unique index, same-application/same-environment
 * consistency from composite foreign keys, and everything the operator can
 * get wrong (revoked connection, foreign price, mismatched provider
 * product, legacy metadata pointing elsewhere) is rejected before any row
 * exists. External provider reads happen in the control-plane orchestration
 * BEFORE this service runs — no network I/O inside database transactions.
 */

export type CatalogMappingRow = typeof providerCatalogMappings.$inferSelect;

export type CatalogLinkComparisonField =
  | "currency"
  | "amountMinor"
  | "billingType"
  | "billingInterval"
  | "mode"
  | "status";

export type CatalogComparisonMismatch = {
  field: CatalogLinkComparisonField;
  monetplane: string;
  provider: string;
};

export type CatalogLinkErrorCode =
  | "invalid_input"
  | "connection_not_found"
  | "connection_revoked"
  | "connection_environment_mismatch"
  | "price_not_found"
  | "price_inactive"
  | "provider_unsupported"
  | "provider_lookup_failed"
  | "provider_product_mismatch"
  | "product_mismatch"
  | "legacy_mapping_conflict"
  | "mapping_conflict";

export class CatalogLinkError extends Error {
  constructor(
    message: string,
    public readonly code: CatalogLinkErrorCode,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CatalogLinkError";
  }
}

type ComparisonPrice = Pick<
  typeof prices.$inferSelect,
  | "currency"
  | "amountMinor"
  | "billingType"
  | "recurringInterval"
  | "intervalCount"
>;

/**
 * Fail-closed comparison of a normalized provider product against a
 * MonetPlane price. Every dimension the issue requires must match exactly:
 * currency, minor-unit amount, billing type, billing interval/interval
 * count, provider-side mode, and product status. Unknown provider values
 * can never compare equal.
 */
export function compareProviderProductWithPrice(
  price: ComparisonPrice,
  product: NormalizedProviderCatalogProduct,
  expectedMode: ProviderMode,
): CatalogComparisonMismatch[] {
  const mismatches: CatalogComparisonMismatch[] = [];

  if (product.currency !== price.currency.toUpperCase()) {
    mismatches.push({
      field: "currency",
      monetplane: price.currency.toUpperCase(),
      provider: product.currency,
    });
  }
  if (product.amountMinor !== price.amountMinor) {
    mismatches.push({
      field: "amountMinor",
      monetplane: String(price.amountMinor),
      provider: String(product.amountMinor),
    });
  }
  if (product.billingType !== price.billingType) {
    mismatches.push({
      field: "billingType",
      monetplane: price.billingType,
      provider: product.billingType,
    });
  } else if (price.billingType === "recurring") {
    if (
      product.recurringInterval !== price.recurringInterval ||
      product.intervalCount !== price.intervalCount
    ) {
      mismatches.push({
        field: "billingInterval",
        monetplane: `${price.recurringInterval ?? "?"} x${price.intervalCount ?? "?"}`,
        provider: `${product.recurringInterval ?? "?"} x${product.intervalCount ?? "?"}`,
      });
    }
  } else if (
    product.recurringInterval !== null ||
    product.intervalCount !== null
  ) {
    mismatches.push({
      field: "billingInterval",
      monetplane: "one-time (no interval)",
      provider: `${product.recurringInterval ?? "?"} x${product.intervalCount ?? "?"}`,
    });
  }

  if (product.mode !== expectedMode) {
    mismatches.push({
      field: "mode",
      monetplane: expectedMode,
      provider: product.mode,
    });
  }
  if (product.status !== "active") {
    mismatches.push({
      field: "status",
      monetplane: "active",
      provider: product.status,
    });
  }

  return mismatches;
}

/**
 * Safe, secret-free verification snapshot stored on the mapping row so an
 * operator can later audit what exactly was verified at link time.
 */
export function verifiedSnapshotFor(
  price: ComparisonPrice,
  product: NormalizedProviderCatalogProduct,
): Record<string, unknown> {
  return {
    verifiedAt: new Date().toISOString(),
    providerProduct: {
      providerProductId: product.providerProductId,
      name: product.name,
      status: product.status,
      mode: product.mode,
      billingType: product.billingType,
      amountMinor: product.amountMinor,
      currency: product.currency,
      recurringInterval: product.recurringInterval,
      intervalCount: product.intervalCount,
      taxCategory: product.taxCategory,
    },
    monetplanePrice: {
      amountMinor: price.amountMinor,
      currency: price.currency.toUpperCase(),
      billingType: price.billingType,
      recurringInterval: price.recurringInterval,
      intervalCount: price.intervalCount,
    },
  };
}

/**
 * Legacy catalog mapping on the connection metadata (the pre-#155 source
 * for checkout). Returns the provider product id it points at, if any —
 * string form `catalog[priceId] = "prod_x"` and object form
 * `catalog[priceId] = { productId: "prod_x" }` are both still read by the
 * adapters, so both are honored here.
 */
export function legacyCatalogProductId(
  connection: Pick<ProviderConnectionView, "metadata">,
  monetplanePriceId: string,
): string | null {
  const catalog = connection.metadata?.catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return null;
  }
  const mapping = (catalog as Record<string, unknown>)[monetplanePriceId];
  if (typeof mapping === "string") return mapping.trim() || null;
  if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
    const productId = (mapping as Record<string, unknown>).productId;
    if (typeof productId === "string") return productId.trim() || null;
  }
  return null;
}

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

export type LinkCatalogProductResult =
  | { outcome: "linked"; mapping: CatalogMappingRow }
  | { outcome: "already_linked"; mapping: CatalogMappingRow }
  /** #156 recovery: an uncertain/failed intent adopted via an explicit link. */
  | { outcome: "recovered"; mapping: CatalogMappingRow };

/**
 * Persist a verified link between a MonetPlane price and an existing
 * provider product. Repeating the exact same link is idempotent (it only
 * refreshes the verification snapshot); any different target — including
 * the legacy metadata catalog pointing at another product — fails closed
 * without touching stored state.
 */
export async function linkProviderCatalogProduct(
  input: {
    applicationId: string;
    environment: ProviderMode;
    providerConnectionId: string;
    monetplanePriceId: string;
    providerProductId: string;
    /** Provider product fetched and normalized by the orchestration layer. */
    product: NormalizedProviderCatalogProduct;
  },
  db: Database = getDb(),
): Promise<LinkCatalogProductResult> {
  const providerProductId = input.providerProductId.trim();
  if (!providerProductId) {
    throw new CatalogLinkError(
      "Provider product ID is required",
      "invalid_input",
    );
  }

  const connection = await getProviderConnection(
    input.applicationId,
    input.providerConnectionId,
    db,
  );
  if (!connection) {
    throw new CatalogLinkError(
      "Provider connection not found in the selected project",
      "connection_not_found",
    );
  }
  if (connection.status !== "active") {
    throw new CatalogLinkError(
      "Provider connection is revoked",
      "connection_revoked",
    );
  }
  if (connection.mode !== input.environment) {
    throw new CatalogLinkError(
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
    throw new CatalogLinkError(
      "MonetPlane price not found in the selected project",
      "price_not_found",
    );
  }
  if (owned.price.status !== "active") {
    throw new CatalogLinkError(
      "MonetPlane price is archived and cannot be linked",
      "price_inactive",
    );
  }

  if (input.product.providerProductId !== providerProductId) {
    throw new CatalogLinkError(
      "Provider returned a different product than the requested ID",
      "provider_product_mismatch",
      {
        requested: providerProductId,
        returned: input.product.providerProductId,
      },
    );
  }

  // Defense in depth: the orchestration already compared these, but the
  // write path re-verifies so a stale fetch can never persist a mismatch.
  const mismatches = compareProviderProductWithPrice(
    owned.price,
    input.product,
    connection.mode,
  );
  if (mismatches.length > 0) {
    throw new CatalogLinkError(
      "Provider product does not match the MonetPlane price",
      "product_mismatch",
      { mismatches },
    );
  }

  const legacyProviderProductId = legacyCatalogProductId(
    connection,
    input.monetplanePriceId,
  );
  if (
    legacyProviderProductId &&
    legacyProviderProductId !== providerProductId
  ) {
    throw new CatalogLinkError(
      "The connection's legacy metadata catalog already maps this price to a different provider product",
      "legacy_mapping_conflict",
      { legacyProviderProductId },
    );
  }

  const now = new Date();
  const verifiedSnapshot = verifiedSnapshotFor(owned.price, input.product);

  const [inserted] = await db
    .insert(providerCatalogMappings)
    .values({
      id: `pcmap_${randomUUID()}`,
      applicationId: input.applicationId,
      providerConnectionId: input.providerConnectionId,
      environment: input.environment,
      monetplanePriceId: input.monetplanePriceId,
      provider: connection.provider,
      providerProductId,
      source: "linked",
      status: "synced",
      verifiedSnapshot,
      lastVerifiedAt: now,
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

  if (inserted) return { outcome: "linked", mapping: inserted };

  // A concurrent request won the unique index: either the identical link
  // (idempotent) or a genuinely different mapping (fail closed).
  const [existing] = await db
    .select()
    .from(providerCatalogMappings)
    .where(
      and(
        eq(providerCatalogMappings.applicationId, input.applicationId),
        eq(providerCatalogMappings.environment, input.environment),
        eq(
          providerCatalogMappings.providerConnectionId,
          input.providerConnectionId,
        ),
        eq(providerCatalogMappings.monetplanePriceId, input.monetplanePriceId),
      ),
    )
    .limit(1);

  if (
    existing &&
    existing.providerProductId === providerProductId &&
    existing.status === "synced"
  ) {
    const [updated] = await db
      .update(providerCatalogMappings)
      .set({
        verifiedSnapshot,
        lastVerifiedAt: now,
        updatedAt: now,
      })
      .where(eq(providerCatalogMappings.id, existing.id))
      .returning();
    return { outcome: "already_linked", mapping: updated ?? existing };
  }

  // #156 recovery path: adopt an uncertain or failed provisioning intent by
  // binding the product the operator located at the provider. This is the
  // explicit, audited resolution for creates whose response was lost —
  // in-flight rows (pending/creating) and synced rows pointing at another
  // product still fail closed below.
  if (
    existing &&
    (existing.status === "needs_reconciliation" || existing.status === "failed")
  ) {
    const [adopted] = await db
      .update(providerCatalogMappings)
      .set({
        providerProductId,
        status: "synced",
        verifiedSnapshot,
        lastVerifiedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerCatalogMappings.id, existing.id),
          inArray(providerCatalogMappings.status, [
            "needs_reconciliation",
            "failed",
          ]),
        ),
      )
      .returning();
    if (adopted) return { outcome: "recovered", mapping: adopted };
  }

  throw new CatalogLinkError(
    "This price already maps to a different provider product or is mid-provisioning; rebinding requires an explicit audited flow",
    "mapping_conflict",
    {
      existingProviderProductId: existing?.providerProductId ?? null,
      existingSource: existing?.source ?? null,
      existingStatus: existing?.status ?? null,
    },
  );
}

export async function listCatalogMappings(
  applicationId: string,
  environment: ProviderMode,
  db: Database = getDb(),
): Promise<CatalogMappingRow[]> {
  return db
    .select()
    .from(providerCatalogMappings)
    .where(
      and(
        eq(providerCatalogMappings.applicationId, applicationId),
        eq(providerCatalogMappings.environment, environment),
      ),
    )
    .orderBy(desc(providerCatalogMappings.createdAt));
}

/**
 * Checkout-time mapping resolution (#155 precedence): only `synced` rows
 * from the persistent table participate; anything else (or no row) leaves
 * the item unresolved so adapters fall back to their legacy connection
 * metadata catalog exactly as before.
 */
export async function resolveCheckoutProviderProductIds(
  applicationId: string,
  providerConnectionId: string,
  priceIds: string[],
  db: Database = getDb(),
): Promise<Map<string, string>> {
  if (priceIds.length === 0) return new Map();
  const rows = await db
    .select({
      monetplanePriceId: providerCatalogMappings.monetplanePriceId,
      providerProductId: providerCatalogMappings.providerProductId,
    })
    .from(providerCatalogMappings)
    .where(
      and(
        eq(providerCatalogMappings.applicationId, applicationId),
        eq(providerCatalogMappings.providerConnectionId, providerConnectionId),
        inArray(providerCatalogMappings.monetplanePriceId, [
          ...new Set(priceIds),
        ]),
        eq(providerCatalogMappings.status, "synced"),
      ),
    );
  return new Map(
    rows.flatMap((row) =>
      row.providerProductId
        ? ([[row.monetplanePriceId, row.providerProductId]] as const)
        : [],
    ),
  );
}
