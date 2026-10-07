import { NextResponse } from "next/server";
import { getDictionary } from "@/i18n/server";
import {
  requireAdmin,
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { createProviderConnection } from "@/modules/providers/service";
import {
  getProviderSetup,
  validateProviderSetupCredentials,
} from "@/modules/providers/setup";
import { recordAuditEntry } from "@/server/control-plane/audit";
import { getProviderList } from "@/server/control-plane/console-queries";
import { getConsoleContext } from "@/server/control-plane/context";

export async function GET() {
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const providers = await getProviderList(
      context.selectedApplication?.id,
      context.environment,
    );
    return NextResponse.json({
      context: {
        application: context.selectedApplication,
        environment: context.environment,
      },
      providers,
    });
  } catch (error) {
    console.error("[admin/providers] Error:", error);
    return NextResponse.json(
      { error: adminErrors.failedToFetchProviders },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const adminErrors = (await getDictionary()).adminErrors;
  const guard = await requirePermission("providers:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const context = await getConsoleContext();
    const application = context.selectedApplication;
    if (!application) {
      return NextResponse.json(
        { error: adminErrors.createOrSelectAProjectBeforeConnectingAProvider },
        { status: 400 },
      );
    }

    const scopeCheck = requireApplicationAccess(guard, application.id);
    if (scopeCheck) return scopeCheck;

    const body = (await request.json()) as {
      provider?: unknown;
      name?: unknown;
      credentials?: unknown;
    };
    const provider =
      typeof body.provider === "string"
        ? body.provider.trim().toLowerCase()
        : "";
    const setup = getProviderSetup(provider);
    if (!setup) {
      return NextResponse.json(
        { error: adminErrors.chooseASupportedPaymentProvider },
        { status: 400 },
      );
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { error: adminErrors.connectionNameIsRequired },
        { status: 400 },
      );
    }

    const rawCredentials =
      body.credentials &&
      typeof body.credentials === "object" &&
      !Array.isArray(body.credentials)
        ? (body.credentials as Record<string, unknown>)
        : {};
    const credentials = validateProviderSetupCredentials(
      setup.provider,
      rawCredentials,
    );

    const connection = await createProviderConnection({
      applicationId: application.id,
      provider: setup.provider,
      name,
      mode: context.environment,
      credentials,
      metadata: {
        source: "console",
      },
    });

    await recordAuditEntry({
      applicationId: application.id,
      environment: context.environment,
      action: "provider.connected",
      resourceType: "provider_connection",
      resourceId: connection.id,
      metadata: { provider: setup.provider, name, mode: context.environment },
      request,
    });
    return NextResponse.json(
      {
        connection,
        context: {
          application,
          environment: context.environment,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[admin/providers] Create error:", error);
    const message =
      error instanceof Error
        ? error.message
        : adminErrors.failedToConnectProvider;
    const status =
      message.includes("required") ||
      message.includes("supported payment provider")
        ? 400
        : message.toLowerCase().includes("unique") ||
            message.toLowerCase().includes("duplicate")
          ? 409
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
