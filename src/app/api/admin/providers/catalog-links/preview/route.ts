import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { CatalogLinkError } from "@/modules/providers/catalog-mapping";
import {
  type CatalogLinkInput,
  catalogLinkErrorResponse,
  previewProviderCatalogLink,
} from "@/server/control-plane/catalog-links";
import { getConsoleContext } from "@/server/control-plane/context";

function parseInput(body: unknown): CatalogLinkInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const providerConnectionId =
    typeof record.connectionId === "string" ? record.connectionId.trim() : "";
  const monetplanePriceId =
    typeof record.priceId === "string" ? record.priceId.trim() : "";
  const providerProductId =
    typeof record.providerProductId === "string"
      ? record.providerProductId.trim()
      : "";
  if (!providerConnectionId || !monetplanePriceId || !providerProductId) {
    return null;
  }
  return {
    providerConnectionId,
    monetplanePriceId,
    providerProductId,
  };
}

/**
 * Read-only validation of a would-be link (#155): fetches the provider
 * product, compares it against the MonetPlane price, and reports existing
 * mappings — without persisting anything.
 */
export async function POST(request: Request) {
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requirePermission("catalog:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const application = context.selectedApplication;
    if (!application) {
      return NextResponse.json(
        { error: adminErrors.noProjectSelected },
        { status: 400 },
      );
    }

    const scopeCheck = requireApplicationAccess(guard, application.id);
    if (scopeCheck) return scopeCheck;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: adminErrors.invalidJsonBody },
        { status: 400 },
      );
    }

    const input = parseInput(rawBody);
    if (!input) {
      return NextResponse.json(
        { error: adminErrors.catalogLinkInvalidInput, code: "invalid_input" },
        { status: 400 },
      );
    }

    const preview = await previewProviderCatalogLink(
      application.id,
      context.environment,
      input,
    );
    return NextResponse.json({ preview });
  } catch (error) {
    if (error instanceof CatalogLinkError) {
      return catalogLinkErrorResponse(error, adminErrors);
    }
    console.error("[admin/providers/catalog-links] Preview error:", error);
    return NextResponse.json(
      { error: adminErrors.failedToPreviewProviderProduct },
      { status: 500 },
    );
  }
}
