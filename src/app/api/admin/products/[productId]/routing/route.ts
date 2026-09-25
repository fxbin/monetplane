import { NextResponse } from "next/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { getConsoleContext } from "@/server/control-plane/context";
import { setProductProviderRoute } from "@/server/control-plane/products";

type RouteContext = {
  params: Promise<{ productId: string }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const guard = await requirePermission("catalog:write");
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

    const scopeCheck = requireApplicationAccess(
      guard,
      context.selectedApplication.id,
    );
    if (scopeCheck) return scopeCheck;

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

    await recordAuditEntry({
      applicationId: context.selectedApplication.id,
      environment: context.environment,
      action: "product.routing_changed",
      resourceType: "product",
      resourceId: productId,
      metadata: { providerConnectionId },
      request,
    });
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
