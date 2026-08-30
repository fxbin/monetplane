import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  createConfiguredProduct,
  listApplicationCatalog,
  products,
  type RecurringInterval,
} from "@/modules/catalog";
import {
  getProviderConnection,
  listProviderConnections,
} from "@/modules/providers/service";
import type { ConsoleEnvironment } from "./context";

export const PRODUCT_BUILDER_TYPES = [
  "one_time",
  "subscription",
  "credit_pack",
  "usage_based",
] as const;

export type ProductBuilderType = (typeof PRODUCT_BUILDER_TYPES)[number];

export type ProductBuilderInput = {
  name: string;
  key: string;
  description?: string | null;
  productType: ProductBuilderType;
  currency: string;
  amountMinor: number;
  recurringInterval?: RecurringInterval;
  providerConnectionId: string;
  credits?: Array<{ referenceKey: string; quantity: number }>;
  features?: Array<{ referenceKey: string }>;
};

type MonetPlaneProductMetadata = {
  productType?: ProductBuilderType;
  providerRouting?: Partial<Record<ConsoleEnvironment, string>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readMonetPlaneMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const value = metadata.monetplane;
  return isRecord(value) ? value : {};
}

export function readProductBuilderType(
  metadata: Record<string, unknown>,
): ProductBuilderType | null {
  const value = readMonetPlaneMetadata(metadata).productType;
  return PRODUCT_BUILDER_TYPES.includes(value as ProductBuilderType)
    ? (value as ProductBuilderType)
    : null;
}

export function readProductProviderRoute(
  metadata: Record<string, unknown>,
  environment: ConsoleEnvironment,
): string | null {
  const routing = readMonetPlaneMetadata(metadata).providerRouting;
  if (!isRecord(routing)) return null;
  const value = routing[environment];
  return typeof value === "string" && value ? value : null;
}

function metadataForBuilder(
  productType: ProductBuilderType,
  environment: ConsoleEnvironment,
  providerConnectionId: string,
): Record<string, unknown> {
  const monetplane: MonetPlaneProductMetadata = {
    productType,
    providerRouting: {
      [environment]: providerConnectionId,
    },
  };

  return { monetplane };
}

function assertBuilderType(value: string): asserts value is ProductBuilderType {
  if (!PRODUCT_BUILDER_TYPES.includes(value as ProductBuilderType)) {
    throw new Error("Choose a supported product type");
  }
}

function assertBenefits(input: ProductBuilderInput) {
  const credits = input.credits ?? [];
  const features = input.features ?? [];

  if (input.productType === "credit_pack" && credits.length === 0) {
    throw new Error("Credit packs must include at least one credit grant");
  }

  if (input.productType === "usage_based" && credits.length === 0) {
    throw new Error(
      "Usage-oriented plans must include a credit allowance to meter usage",
    );
  }

  for (const credit of credits) {
    if (!credit.referenceKey.trim()) {
      throw new Error("Every credit grant needs a credit type key");
    }
    if (!Number.isSafeInteger(credit.quantity) || credit.quantity <= 0) {
      throw new Error("Credit quantities must be positive whole numbers");
    }
  }

  for (const feature of features) {
    if (!feature.referenceKey.trim()) {
      throw new Error("Every feature needs an entitlement key");
    }
  }
}

function billingShape(productType: ProductBuilderType) {
  if (productType === "one_time" || productType === "credit_pack") {
    return { billingType: "one_time" as const };
  }

  return { billingType: "recurring" as const };
}

async function assertProviderForEnvironment(
  applicationId: string,
  environment: ConsoleEnvironment,
  providerConnectionId: string,
) {
  if (!providerConnectionId.trim()) {
    throw new Error("Choose a payment provider for this environment");
  }

  const provider = await getProviderConnection(
    applicationId,
    providerConnectionId,
  );
  if (!provider || provider.status !== "active") {
    throw new Error("Selected payment provider is not active for this project");
  }
  if (provider.mode !== environment) {
    throw new Error(
      `Selected provider belongs to ${provider.mode === "test" ? "Sandbox" : "Production"}, not the current environment`,
    );
  }

  return provider;
}

export async function createProductFromBuilder(
  applicationId: string,
  environment: ConsoleEnvironment,
  input: ProductBuilderInput,
) {
  assertBuilderType(input.productType);
  assertBenefits(input);

  const provider = await assertProviderForEnvironment(
    applicationId,
    environment,
    input.providerConnectionId,
  );

  const billing = billingShape(input.productType);
  if (
    billing.billingType === "recurring" &&
    input.recurringInterval !== "month" &&
    input.recurringInterval !== "year"
  ) {
    throw new Error("Recurring products require a monthly or annual interval");
  }

  const priceKey =
    billing.billingType === "recurring"
      ? input.recurringInterval === "year"
        ? "annual"
        : "monthly"
      : "default";

  const result = await createConfiguredProduct({
    applicationId,
    key: input.key,
    name: input.name,
    description: input.description,
    metadata: metadataForBuilder(
      input.productType,
      environment,
      provider.id,
    ),
    price: {
      key: priceKey,
      currency: input.currency,
      amountMinor: input.amountMinor,
      billingType: billing.billingType,
      recurringInterval:
        billing.billingType === "recurring" ? input.recurringInterval : undefined,
      intervalCount: billing.billingType === "recurring" ? 1 : undefined,
      metadata: { role: "primary" },
    },
    grants: [
      ...(input.credits ?? []).map((credit) => ({
        grantType: "credit" as const,
        referenceKey: credit.referenceKey,
        quantity: credit.quantity,
      })),
      ...(input.features ?? []).map((feature) => ({
        grantType: "entitlement" as const,
        referenceKey: feature.referenceKey,
      })),
    ],
  });

  return { ...result, provider };
}

export async function setProductProviderRoute(
  applicationId: string,
  productId: string,
  environment: ConsoleEnvironment,
  providerConnectionId: string,
) {
  const provider = await assertProviderForEnvironment(
    applicationId,
    environment,
    providerConnectionId,
  );
  const db = getDb();
  const [product] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.applicationId, applicationId),
      ),
    )
    .limit(1);

  if (!product) {
    throw new Error("Product not found in the current project");
  }

  const monetplane = readMonetPlaneMetadata(product.metadata);
  const existingRouting = isRecord(monetplane.providerRouting)
    ? monetplane.providerRouting
    : {};
  const metadata = {
    ...product.metadata,
    monetplane: {
      ...monetplane,
      providerRouting: {
        ...existingRouting,
        [environment]: provider.id,
      },
    },
  };

  const [updatedProduct] = await db
    .update(products)
    .set({ metadata, updatedAt: new Date() })
    .where(
      and(
        eq(products.id, productId),
        eq(products.applicationId, applicationId),
      ),
    )
    .returning();

  if (!updatedProduct) {
    throw new Error("Failed to update product provider routing");
  }

  return { product: updatedProduct, provider };
}

export async function getProductBuilderList(
  applicationId: string,
  environment: ConsoleEnvironment,
) {
  const [catalog, providers] = await Promise.all([
    listApplicationCatalog(applicationId),
    listProviderConnections(applicationId),
  ]);
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );

  return catalog
    .map(({ product, prices, grants }) => {
      const activePrices = prices.filter((price) => price.status === "active");
      const primaryPrice =
        activePrices.find((price) => price.metadata.role === "primary") ??
        activePrices[0] ??
        prices[0] ??
        null;
      const providerConnectionId = readProductProviderRoute(
        product.metadata,
        environment,
      );
      const provider = providerConnectionId
        ? providersById.get(providerConnectionId) ?? null
        : null;

      return {
        product,
        productType: readProductBuilderType(product.metadata),
        primaryPrice,
        grants,
        creditGrants: grants.filter((grant) => grant.grantType === "credit"),
        featureGrants: grants.filter(
          (grant) => grant.grantType === "entitlement",
        ),
        provider,
        providerConnectionId,
      };
    })
    .sort(
      (a, b) => b.product.createdAt.getTime() - a.product.createdAt.getTime(),
    );
}

export async function getProductBuilderDetail(
  applicationId: string,
  productId: string,
  environment: ConsoleEnvironment,
) {
  const rows = await getProductBuilderList(applicationId, environment);
  return rows.find((row) => row.product.id === productId) ?? null;
}

export async function getBuilderProviderOptions(
  applicationId: string,
  environment: ConsoleEnvironment,
) {
  const providers = await listProviderConnections(applicationId, getDb());
  return providers.filter(
    (provider) => provider.status === "active" && provider.mode === environment,
  );
}
