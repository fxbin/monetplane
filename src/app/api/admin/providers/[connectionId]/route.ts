import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import {
  getProviderConnection,
  revokeProviderConnection,
  updateProviderConnection,
} from "@/modules/providers/service";
import {
  getProviderSetup,
  validateProviderSetupCredentials,
} from "@/modules/providers/setup";
import { getConsoleContext } from "@/server/control-plane/context";
import { getConsoleProviderConnectionDetail } from "@/server/control-plane/providers";

type RouteContext = {
  params: Promise<{ connectionId: string }>;
};

async function resolveScopedConnection(connectionId: string) {
  const context = await getConsoleContext();
  const application = context.selectedApplication;
  if (!application) return { context, connection: null };

  const connection = await getProviderConnection(application.id, connectionId);
  if (!connection || connection.mode !== context.environment) {
    return { context, connection: null };
  }
  return { context, connection };
}

export async function GET(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const { connectionId } = await params;
  const { context, connection } = await resolveScopedConnection(connectionId);
  if (!context.selectedApplication || !connection) {
    return NextResponse.json(
      { error: "Provider connection not found" },
      { status: 404 },
    );
  }

  const detail = await getConsoleProviderConnectionDetail(
    context.selectedApplication.id,
    connection.id,
    context.environment,
  );
  if (!detail) {
    return NextResponse.json(
      { error: "Provider connection not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ detail });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const { connectionId } = await params;
    const { context, connection } = await resolveScopedConnection(connectionId);
    const application = context.selectedApplication;
    if (!application || !connection) {
      return NextResponse.json(
        { error: "Provider connection not found" },
        { status: 404 },
      );
    }
    if (connection.status !== "active") {
      return NextResponse.json(
        { error: "Revoked provider connections cannot be reconfigured" },
        { status: 409 },
      );
    }

    const body = (await request.json()) as {
      name?: unknown;
      credentials?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    let credentials: Record<string, string> | undefined;

    if (body.credentials !== undefined) {
      const setup = getProviderSetup(connection.provider);
      if (!setup) {
        return NextResponse.json(
          { error: "This provider cannot be reconfigured from the console" },
          { status: 400 },
        );
      }
      const rawCredentials =
        body.credentials &&
        typeof body.credentials === "object" &&
        !Array.isArray(body.credentials)
          ? (body.credentials as Record<string, unknown>)
          : {};
      credentials = validateProviderSetupCredentials(
        setup.provider,
        rawCredentials,
      );
    }

    const updated = await updateProviderConnection(
      application.id,
      connection.id,
      { name, credentials },
    );
    if (!updated) {
      return NextResponse.json(
        { error: "Provider connection is no longer active" },
        { status: 409 },
      );
    }

    return NextResponse.json({ connection: updated });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update provider connection";
    const status =
      message.includes("required") || message.includes("changes") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const { connectionId } = await params;
  const { context, connection } = await resolveScopedConnection(connectionId);
  const application = context.selectedApplication;
  if (!application || !connection) {
    return NextResponse.json(
      { error: "Provider connection not found" },
      { status: 404 },
    );
  }
  if (connection.status === "revoked") {
    return NextResponse.json({ connection });
  }

  const revoked = await revokeProviderConnection(application.id, connection.id);
  if (!revoked) {
    return NextResponse.json(
      { error: "Provider connection could not be revoked" },
      { status: 409 },
    );
  }

  const current = await getProviderConnection(application.id, connection.id);
  return NextResponse.json({ connection: current });
}
