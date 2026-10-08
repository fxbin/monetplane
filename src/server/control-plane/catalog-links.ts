import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { prices, products } from "@/modules/catalog/schema";
import {
  type CatalogComparisonMismatch,
  CatalogLinkError,
  type CatalogLinkErrorCode,
  type CatalogMappingRow,
  compareProviderProductWithPrice,
  legacyCatalogProductId,
  linkProviderCatalogProduct,
  listCatalogMappings,
} from "@/modules/providers/catalog-mapping";
import type { NormalizedProviderCatalogProduct } from "@/modules/providers/contract";
import {
  ProviderCatalogLookupUnsupportedError,
  ProviderOperationError,
} from "@/modules/providers/contract";
import { getProviderCatalogProduct } from "@/modules/providers/runtime";
import { getProviderConnection } from "@/modules/providers/service";
import type { ConsoleEnvironment } from "./context";

/**
 * Console orchestration for the provider catalog link flow (#155):
 * read-only validation (preview) and the audited link write. External
 * Creem reads happen here, strictly BEFORE the mapping service touches the
 * database, and every outcome the operator can observe — created,
 * re-verified, rejected — lands in the operator audit log without any
 * credential material.
 */

const CATALOG_LINK_STATUS_BY_CODE: Record<CatalogLinkErrorCode, number> = {
  invalid_input: 400,
  connection_not_found: 404,
  connection_revoked: 400,
  connection_environment_mismatch: 400,
  price_not_found: 404,
  price_inactive: 400,
  provider_unsupported: 400,
  provider_lookup_failed: 400,
  provider_product_mismatch: 400,
  product_mismatch: 400,
  legacy_mapping_conflict: 400,
  mapping_conflict: 409,
};

const CATALOG_LINK_MESSAGE_KEY_BY_CODE: Record<CatalogLinkErrorCode, string> = {
  invalid_input: "catalogLinkInvalidInput",
  connection_not_found: "catalogLinkConnectionNotFound",
  connection_revoked: "catalogLinkConnectionRevoked",
  connection_environment_mismatch: "catalogLinkEnvironmentMismatch",
  price_not_found: "catalogLinkPriceNotFound",
  price_inactive: "catalogLinkPriceInactive",
  provider_unsupported: "catalogLinkProviderUnsupported",
  provider_lookup_failed: "catalogLinkProviderLookupFailed",
  provider_product_mismatch: "catalogLinkProductMismatch",
  product_mismatch: "catalogLinkProductMismatch",
  legacy_mapping_conflict: "catalogLinkLegacyConflict",
  mapping_conflict: "catalogLinkMappingConflict",
};

type AdminErrorsDictionary = Record<string, unknown>;

/**
 * Map a typed CatalogLinkError onto the admin route contract. Structured
 * details (mismatch list, conflicting ids) ride along for the console;
 * they are derived from provider product fields and request ids only —
 * never credentials. Routes import this because Next.js route files may
 * only export HTTP method handlers.
 */
export function catalogLinkErrorResponse(
  error: CatalogLinkError,
  adminErrors: AdminErrorsDictionary,
): NextResponse {
  const messageKey = CATALOG_LINK_MESSAGE_KEY_BY_CODE[error.code];
  const message = messageKey ? adminErrors[messageKey] : undefined;
  return NextResponse.json(
    {
      error: typeof message === "string" ? message : error.message,
      code: error.code,
      details: error.details,
    },
    { status: CATALOG_LINK_STATUS_BY_CODE[error.code] ?? 400 },
  );
}

export type CatalogLinkPreview = {
  connection: {
    id: string;
    provider: string;
    name: string;
    mode: ConsoleEnvironment;
  };
  price: {
    id: string;
    key: string;
    productId: string;
    productName: string;
    currency: string;
    amountMinor: number;
    billingType: string;
    recurringInterval: string | null;
    intervalCount: number | null;
  };
  providerProductId: string;
  product: NormalizedProviderCatalogProduct | null;
  match: { ok: boolean; mismatches: CatalogComparisonMismatch[] };
  existingMapping: {
    providerProductId: string;
    source: string;
    status: string;
  } | null;
  legacyProviderProductId: string | null;
};

function toProviderLookupError(cause: unknown): CatalogLinkError {
  if (
    cause instanceof ProviderOperationError &&
    cause.failureKind === "rejected"
  ) {
    return new CatalogLinkError(cause.message, "provider_lookup_failed");
  }
  return new CatalogLinkError(
    cause instanceof Error
      ? `Provider product lookup failed: ${cause.message}`
      : "Provider product lookup failed",
    "provider_lookup_failed",
  );
}

async function loadConnectionAndPrice(
  applicationId: string,
  environment: ConsoleEnvironment,
  input: CatalogLinkInput,
) {
  const connection = await getProviderConnection(
    applicationId,
    input.providerConnectionId,
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
  if (connection.mode !== environment) {
    throw new CatalogLinkError(
      `Provider connection belongs to the ${connection.mode} environment, not ${environment}`,
      "connection_environment_mismatch",
      {
        connectionMode: connection.mode,
        requestedEnvironment: environment,
      },
    );
  }

  const [priceRow] = await getDb()
    .select({ price: prices, product: products })
    .from(prices)
    .innerJoin(products, eq(prices.productId, products.id))
    .where(
      and(
        eq(prices.id, input.monetplanePriceId),
        eq(products.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (!priceRow) {
    throw new CatalogLinkError(
      "MonetPlane price not found in the selected project",
      "price_not_found",
    );
  }
  if (priceRow.price.status !== "active") {
    throw new CatalogLinkError(
      "MonetPlane price is archived and cannot be linked",
      "price_inactive",
    );
  }

  return { connection, priceRow };
}

export type CatalogLinkInput = {
  providerConnectionId: string;
  monetplanePriceId: string;
  providerProductId: string;
};

async function findExistingMapping(
  applicationId: string,
  environment: ConsoleEnvironment,
  input: CatalogLinkInput,
): Promise<CatalogMappingRow | null> {
  const mappings = await listCatalogMappings(applicationId, environment);
  return (
    mappings.find(
      (mapping) =>
        mapping.providerConnectionId === input.providerConnectionId &&
        mapping.monetplanePriceId === input.monetplanePriceId,
    ) ?? null
  );
}

/** Read-only validation of a would-be link. Persists nothing. */
export async function previewProviderCatalogLink(
  applicationId: string,
  environment: ConsoleEnvironment,
  input: CatalogLinkInput,
): Promise<CatalogLinkPreview> {
  const providerProductId = input.providerProductId.trim();
  if (!providerProductId) {
    throw new CatalogLinkError(
      "Provider product ID is required",
      "invalid_input",
    );
  }

  const { connection, priceRow } = await loadConnectionAndPrice(
    applicationId,
    environment,
    input,
  );

  let product: NormalizedProviderCatalogProduct | null = null;
  try {
    product = await getProviderCatalogProduct(applicationId, connection.id, {
      providerProductId,
    });
  } catch (cause) {
    throw toProviderLookupError(cause);
  }

  const mismatches = compareProviderProductWithPrice(
    priceRow.price,
    product,
    connection.mode,
  );

  return {
    connection: {
      id: connection.id,
      provider: connection.provider,
      name: connection.name,
      mode: connection.mode,
    },
    price: {
      id: priceRow.price.id,
      key: priceRow.price.key,
      productId: priceRow.product.id,
      productName: priceRow.product.name,
      currency: priceRow.price.currency,
      amountMinor: priceRow.price.amountMinor,
      billingType: priceRow.price.billingType,
      recurringInterval: priceRow.price.recurringInterval,
      intervalCount: priceRow.price.intervalCount,
    },
    providerProductId,
    product,
    match: { ok: mismatches.length === 0, mismatches },
    existingMapping: await findExistingMapping(
      applicationId,
      environment,
      input,
    ),
    legacyProviderProductId: legacyCatalogProductId(
      connection,
      input.monetplanePriceId,
    ),
  };
}

/**
 * Validate and persist a link, writing the operator audit entry for every
 * outcome. The provider fetch and comparison run first; the mapping
 * service re-verifies before its single guarded INSERT.
 */
export async function linkProviderCatalogProductFromConsole(
  applicationId: string,
  environment: ConsoleEnvironment,
  input: CatalogLinkInput,
  audit: (entry: {
    action: string;
    resourceId: string;
    metadata: Record<string, unknown>;
    outcome: "linked" | "reverified" | "rejected";
    code?: CatalogLinkErrorCode;
  }) => Promise<void>,
): Promise<
  | {
      outcome: "linked";
      mapping: CatalogMappingRow;
      preview: CatalogLinkPreview;
    }
  | {
      outcome: "already_linked";
      mapping: CatalogMappingRow;
      preview: CatalogLinkPreview;
    }
> {
  let auditResourceId = `price:${input.monetplanePriceId}`;
  try {
    const preview = await previewProviderCatalogLink(
      applicationId,
      environment,
      input,
    );
    if (!preview.match.ok) {
      throw new CatalogLinkError(
        "Provider product does not match the MonetPlane price",
        "product_mismatch",
        { mismatches: preview.match.mismatches },
      );
    }

    const result = await linkProviderCatalogProduct(
      {
        applicationId,
        environment,
        providerConnectionId: input.providerConnectionId,
        monetplanePriceId: input.monetplanePriceId,
        providerProductId: input.providerProductId,
        product: preview.product as NormalizedProviderCatalogProduct,
      },
      getDb(),
    );

    auditResourceId = result.mapping.id;
    await audit({
      action:
        result.outcome === "linked"
          ? "provider_catalog.linked"
          : "provider_catalog.link_reverified",
      resourceId: result.mapping.id,
      outcome: result.outcome === "linked" ? "linked" : "reverified",
      metadata: {
        providerConnectionId: input.providerConnectionId,
        monetplanePriceId: input.monetplanePriceId,
        providerProductId: result.mapping.providerProductId,
        environment,
        source: result.mapping.source,
        status: result.mapping.status,
      },
    });
    return { ...result, preview };
  } catch (error) {
    // Single rejection-audit point for every typed failure (validation,
    // provider lookup, conflicts) — the operator sees the reason category
    // without any credential material.
    if (error instanceof CatalogLinkError) {
      await audit({
        action: "provider_catalog.link_rejected",
        resourceId: auditResourceId,
        outcome: "rejected",
        code: error.code,
        metadata: {
          providerConnectionId: input.providerConnectionId,
          monetplanePriceId: input.monetplanePriceId,
          providerProductId: input.providerProductId,
          reason: error.code,
          details: error.details,
        },
      });
    }
    throw error;
  }
}
