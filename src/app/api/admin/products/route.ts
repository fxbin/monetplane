import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getProductList } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";
import {
  createProductFromBuilder,
  type ProductBuilderInput,
} from "@/server/control-plane/products";

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const products = await getProductList(context.selectedApplication?.id);
    return NextResponse.json({
      context: {
        application: context.selectedApplication,
        environment: context.environment,
      },
      products,
    });
  } catch (error) {
    console.error("[admin/products] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    if (!context.selectedApplication) {
      return NextResponse.json(
        {
          error: "Create or select a project before creating a product",
          code: "project_required",
        },
        { status: 400 },
      );
    }

    const body = (await request.json()) as Partial<ProductBuilderInput>;
    const result = await createProductFromBuilder(
      context.selectedApplication.id,
      context.environment,
      {
        name: typeof body.name === "string" ? body.name : "",
        key: typeof body.key === "string" ? body.key : "",
        description:
          typeof body.description === "string" ? body.description : null,
        productType:
          typeof body.productType === "string"
            ? (body.productType as ProductBuilderInput["productType"])
            : "one_time",
        currency: typeof body.currency === "string" ? body.currency : "USD",
        amountMinor:
          typeof body.amountMinor === "number" ? body.amountMinor : Number.NaN,
        recurringInterval:
          body.recurringInterval === "month" || body.recurringInterval === "year"
            ? body.recurringInterval
            : undefined,
        providerConnectionId:
          typeof body.providerConnectionId === "string"
            ? body.providerConnectionId
            : "",
        credits: Array.isArray(body.credits)
          ? body.credits.map((credit) => ({
              referenceKey:
                typeof credit.referenceKey === "string" ? credit.referenceKey : "",
              quantity:
                typeof credit.quantity === "number" ? credit.quantity : Number.NaN,
            }))
          : [],
        features: Array.isArray(body.features)
          ? body.features.map((feature) => ({
              referenceKey:
                typeof feature.referenceKey === "string" ? feature.referenceKey : "",
            }))
          : [],
      },
    );

    return NextResponse.json(
      {
        product: result.product,
        price: result.price,
        grants: result.grants,
        provider: {
          id: result.provider.id,
          provider: result.provider.provider,
          name: result.provider.name,
          mode: result.provider.mode,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[admin/products] Create error:", error);
    const message = error instanceof Error ? error.message : "Failed to create product";
    const isConflict = /unique|duplicate/i.test(message);

    return NextResponse.json(
      {
        error: isConflict
          ? "A product or price with this key already exists in the current project"
          : message,
        code: isConflict ? "catalog_conflict" : "invalid_product",
      },
      { status: isConflict ? 409 : 400 },
    );
  }
}
