import { NextResponse } from "next/server";
import { requireAdmin } from "@/modules/admin/guard";
import { getConsoleContext } from "@/server/control-plane/context";
import {
  ConsoleProviderDiagnosticError,
  type ConsoleProviderDiagnosticKind,
  runConsoleProviderDiagnostic,
} from "@/server/control-plane/providers";

type RouteContext = {
  params: Promise<{ connectionId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ connectionId }, context, body] = await Promise.all([
      params,
      getConsoleContext(),
      request.json() as Promise<{
        kind?: unknown;
        providerResourceId?: unknown;
      }>,
    ]);
    const application = context.selectedApplication;
    if (!application) {
      return NextResponse.json(
        { error: "Select a project first" },
        { status: 400 },
      );
    }

    const kind =
      body.kind === "configuration" ||
      body.kind === "payment" ||
      body.kind === "subscription"
        ? (body.kind as ConsoleProviderDiagnosticKind)
        : null;
    if (!kind) {
      return NextResponse.json(
        { error: "Choose configuration, payment, or subscription diagnostic" },
        { status: 400 },
      );
    }

    const result = await runConsoleProviderDiagnostic(
      application.id,
      connectionId,
      context.environment,
      {
        kind,
        providerResourceId:
          typeof body.providerResourceId === "string"
            ? body.providerResourceId
            : undefined,
      },
    );
    return NextResponse.json({ result });
  } catch (error) {
    console.error("[admin/providers/diagnostics] Error:", error);
    if (error instanceof ConsoleProviderDiagnosticError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "revoked"
            ? 409
            : error.code === "invalid_input"
              ? 400
              : 502;
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status },
      );
    }
    return NextResponse.json(
      { error: "Provider diagnostic failed" },
      { status: 500 },
    );
  }
}
