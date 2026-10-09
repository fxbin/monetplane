import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { CatalogProvisionError } from "@/modules/providers/catalog-provisioning";
import { recordAuditEntry } from "@/server/control-plane/audit";
import {
  type CatalogProvisionInput,
  catalogProvisionErrorResponse,
  provisionProviderCatalogProductFromConsole,
} from "@/server/control-plane/catalog-provisioning";
import { getConsoleContext } from "@/server/control-plane/context";

function parseInput(body: unknown): CatalogProvisionInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const providerConnectionId =
    typeof record.connectionId === "string" ? record.connectionId.trim() : "";
  const monetplanePriceId =
    typeof record.priceId === "string" ? record.priceId.trim() : "";
  if (!providerConnectionId || !monetplanePriceId) return null;
  return {
    providerConnectionId,
    monetplanePriceId,
    name: typeof record.name === "string" ? record.name : undefined,
    description:
      typeof record.description === "string" ? record.description : null,
    taxCategory:
      typeof record.taxCategory === "string" ? record.taxCategory : null,
  };
}

/**
 * Create a provider product from a MonetPlane price (#156). Console
 * session + catalog:write + application scope only — business mp_app_*
 * credentials cannot reach this route.
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
        { error: adminErrors.provisionInvalidInput, code: "invalid_input" },
        { status: 400 },
      );
    }

    const result = await provisionProviderCatalogProductFromConsole(
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
        ...(result.outcome === "created"
          ? { providerProductId: result.providerProductId }
          : {}),
      },
      { status: result.outcome === "created" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof CatalogProvisionError) {
      return catalogProvisionErrorResponse(error, adminErrors);
    }
    console.error("[admin/providers/catalog-products] Provision error:", error);
    return NextResponse.json(
      { error: adminErrors.failedToProvisionProviderProduct },
      { status: 500 },
    );
  }
}
