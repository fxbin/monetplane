import type { ConsoleEnvironment } from "./context";

export const PRODUCT_BUILDER_TYPES = [
  "one_time",
  "subscription",
  "credit_pack",
  "usage_based",
] as const;

export type ProductBuilderType = (typeof PRODUCT_BUILDER_TYPES)[number];

type MonetPlaneProductMetadata = {
  productType?: ProductBuilderType;
  providerRouting?: Partial<Record<ConsoleEnvironment, string>>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readMonetPlaneMetadata(
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

export function metadataForBuilder(
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
