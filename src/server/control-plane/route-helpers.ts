import { NextResponse } from "next/server";
import {
  type AdminActor,
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import type { ConsoleEnvironment } from "./context";
import { getConsoleContext } from "./context";

/**
 * Admin console route helper (roundtable batch 2): the guard/scope/try
 * preamble that every admin action route copy-pasted (~28×). Routes
 * migrate on touch (scout rule); the money surface is migrated first.
 * SDK-surface error mapping lives separately in ./sdk-route-errors.ts —
 * public routes must not transitively load the admin guard.
 */

export type AdminActionContext = {
  request: Request;
  guard: AdminActor;
  applicationId: string;
  environment: ConsoleEnvironment;
  /** Dynamic-route params (resolves to {} for static routes). */
  params: Promise<Record<string, string>>;
};

/**
 * Wraps an admin console action with the standard preamble — permission
 * guard, console context, application selection, scope check — and the
 * standard catch (log + 400 with the error's message; journal/domain
 * errors carry operator-facing guidance by design). Eliminates the
 * 28× copy-pasted guard prologue.
 *
 * Note: getConsoleContext() runs OUTSIDE the try (unlike the old inline
 * routes) — an infrastructure failure there is a 500, not a 400, which is
 * the honest classification.
 */
export function adminAction(
  permission: Parameters<typeof requirePermission>[0],
  handler: (ctx: AdminActionContext) => Promise<NextResponse>,
) {
  return async (
    request: Request,
    route?: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    const guard = await requirePermission(permission);
    if (guard instanceof NextResponse) return guard;

    const context = await getConsoleContext();
    if (!context.selectedApplication) {
      return NextResponse.json(
        { error: "Select a project first" },
        { status: 400 },
      );
    }

    const scopeCheck = requireApplicationAccess(
      guard,
      context.selectedApplication.id,
    );
    if (scopeCheck) return scopeCheck;

    try {
      return await handler({
        request,
        guard,
        applicationId: context.selectedApplication.id,
        environment: context.environment,
        params: route?.params ?? Promise.resolve({}),
      });
    } catch (error) {
      console.error("[admin-action] Error:", error);
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Request failed",
        },
        { status: 400 },
      );
    }
  };
}
