import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import {
  CatalogProvisionError,
  failNeedsReconciliationIntent,
} from "@/modules/providers/catalog-provisioning";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { catalogProvisionErrorResponse } from "@/server/control-plane/catalog-provisioning";
import { getConsoleContext } from "@/server/control-plane/context";

/**
 * Explicit recovery action (#156): park a needs_reconciliation intent as
 * failed so it can be retried. Audited; refuses any other state.
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

    let rawBody: Record<string, unknown>;
    try {
      rawBody = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: adminErrors.invalidJsonBody },
        { status: 400 },
      );
    }
    const providerConnectionId =
      typeof rawBody.connectionId === "string"
        ? rawBody.connectionId.trim()
        : "";
    const monetplanePriceId =
      typeof rawBody.priceId === "string" ? rawBody.priceId.trim() : "";
    if (!providerConnectionId || !monetplanePriceId) {
      return NextResponse.json(
        { error: adminErrors.provisionInvalidInput, code: "invalid_input" },
        { status: 400 },
      );
    }

    const mapping = await failNeedsReconciliationIntent({
      applicationId: application.id,
      environment: context.environment,
      providerConnectionId,
      monetplanePriceId,
    });

    await recordAuditEntry({
      applicationId: application.id,
      environment: context.environment,
      action: "provider_catalog.intent_failed",
      resourceType: "provider_catalog_mapping",
      resourceId: mapping.id,
      metadata: {
        providerConnectionId,
        monetplanePriceId,
        reason: "operator marked uncertain intent failed for retry",
      },
      request,
      actor: { id: guard.operatorId, label: guard.name },
    });

    return NextResponse.json({ outcome: "intent_failed", mapping });
  } catch (error) {
    if (error instanceof CatalogProvisionError) {
      return catalogProvisionErrorResponse(error, adminErrors);
    }
    console.error(
      "[admin/providers/catalog-products] Fail-intent error:",
      error,
    );
    return NextResponse.json(
      { error: adminErrors.failedToFailProvisionIntent },
      { status: 500 },
    );
  }
}
