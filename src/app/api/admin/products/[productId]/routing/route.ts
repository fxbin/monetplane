import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getConsoleContext } from "@/server/control-plane/context";
import { setProductProviderRoute } from "@/server/control-plane/products";

type RouteContext = {
  params: Promise<{ productId: string }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ productId }, context, body] = await Promise.all([
      params,
      getConsoleContext(),
      request.json() as Promise<{ providerConnectionId?: unknown }>,
    ]);

    if (!context.selectedApplication) {
      return NextResponse.json(
        { error: "Select a project before changing product routing" },
        { status: 400 },
      );
    }

    const providerConnectionId =
      typeof body.providerConnectionId === "string"
        ? body.providerConnectionId
        : "";

    const result = await setProductProviderRoute(
      context.selectedApplication.id,
      productId,
      context.environment,
      providerConnectionId,
    );

    return NextResponse.json({
      product: result.product,
      provider: {
        id: result.provider.id,
        provider: result.provider.provider,
        name: result.provider.name,
        mode: result.provider.mode,
      },
      environment: context.environment,
    });
  } catch (error) {
    console.error("[admin/products/routing] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update product provider routing",
      },
      { status: 400 },
    );
  }
}
