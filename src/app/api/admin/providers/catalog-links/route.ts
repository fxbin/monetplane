import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { CatalogLinkError } from "@/modules/providers/catalog-mapping";
import { recordAuditEntry } from "@/server/control-plane/audit";
import {
  type CatalogLinkInput,
  catalogLinkErrorResponse,
  linkProviderCatalogProductFromConsole,
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

    const result = await linkProviderCatalogProductFromConsole(
      application.id,
      context.environment,
      input,
      async (entry) => {
        await recordAuditEntry({
          applicationId: application.id,
          environment: context.environment,
          action: entry.action,
          resourceType: "provider_catalog_mapping",
          resourceId: entry.resourceId,
          metadata: entry.metadata,
          request,
          actor: { id: guard.operatorId, label: guard.name },
        });
      },
    );

    const { mapping } = result;
    return NextResponse.json(
      {
        outcome: result.outcome,
        mapping: {
          id: mapping.id,
          providerConnectionId: mapping.providerConnectionId,
          monetplanePriceId: mapping.monetplanePriceId,
          provider: mapping.provider,
          providerProductId: mapping.providerProductId,
          source: mapping.source,
          status: mapping.status,
          environment: mapping.environment,
          lastVerifiedAt: mapping.lastVerifiedAt,
          createdAt: mapping.createdAt,
        },
        preview: result.preview,
      },
      { status: result.outcome === "linked" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof CatalogLinkError) {
      return catalogLinkErrorResponse(error, adminErrors);
    }
    console.error("[admin/providers/catalog-links] Link error:", error);
    return NextResponse.json(
      { error: adminErrors.failedToLinkProviderProduct },
      { status: 500 },
    );
  }
}
