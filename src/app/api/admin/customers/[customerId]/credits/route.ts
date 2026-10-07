import { NextResponse } from "next/server";
import {
  requireApplicationAccess,
  requirePermission,
} from "@/modules/admin/guard";
import { getConsoleContext } from "@/server/control-plane/context";
import { parseGrantExpiry } from "@/server/control-plane/credit-grant-expiry";
import { grantCustomerCredits } from "@/server/control-plane/customer-workspace";

type RouteContext = {
  params: Promise<{ customerId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const guard = await requirePermission("credits:write");
  if (guard instanceof NextResponse) return guard;

  try {
    const [{ customerId }, context, body] = await Promise.all([
      params,
      getConsoleContext(),
      request.json() as Promise<{
        creditType?: unknown;
        amount?: unknown;
        note?: unknown;
        idempotencyKey?: unknown;
        expiresAt?: unknown;
        expiresInDays?: unknown;
      }>,
    ]);
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

    const creditType =
      typeof body.creditType === "string" ? body.creditType.trim() : "";
    // Strict number (audit M6): string coercion ("5" or "abc" -> NaN) is
    // inconsistent with every other money entry point.
    const amount =
      typeof body.amount === "number" && Number.isSafeInteger(body.amount)
        ? body.amount
        : Number.NaN;
    const note = typeof body.note === "string" ? body.note : undefined;
    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim().slice(0, 200)
        : undefined;
    if (!creditType) {
      return NextResponse.json(
        { error: "Credit type is required" },
        { status: 400 },
      );
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "Amount must be a positive whole number" },
        { status: 400 },
      );
    }

    const expiry = parseGrantExpiry(body);
    if (expiry.error) return expiry.error;
    const { expiresAt } = expiry;

    // The audit row is written inside the grant's transaction
    // (roundtable batch 1) — actor comes from the permission guard.
    const result = await grantCustomerCredits(
      context.selectedApplication.id,
      customerId,
      { creditType, amount, note, idempotencyKey, expiresAt },
      context.environment,
      {
        request,
        actor: { id: guard.operatorId, label: guard.name || guard.email },
      },
    );
    return NextResponse.json({ transaction: result.transaction });
  } catch (error) {
    console.error("[admin/customers/credits] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to grant credits",
      },
      { status: 400 },
    );
  }
}
