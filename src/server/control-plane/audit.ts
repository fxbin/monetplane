import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { operatorAuditLog } from "@/modules/operations/audit-schema";

/**
 * Operator audit recorder (#66).
 *
 * Sensitive console mutations append immutable audit entries scoped to the
 * application (fail-closed: the route supplies the applicationId it already
 * authorized — the recorder never trusts a caller-supplied target). Actor
 * identity comes from the admin session. Metadata is deep-redacted so
 * plaintext credentials can never reach the audit table or the console.
 */

const SECRET_KEY_PATTERN =
  /(secret|credential|password|passwd|token|api[-_]?key|private[-_]?key|signing)/i;
const MAX_VALUE_LENGTH = 200;

export type AuditEnvironment = "test" | "live" | null;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
      return `${value.slice(0, MAX_VALUE_LENGTH)}…`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactValue(item, depth + 1);
    }
  }
  return result;
}

export function redactAuditMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return redactValue(metadata) as Record<string, unknown>;
}

export function correlationIdFrom(request: Request | undefined): string {
  const header = request?.headers.get("x-monetplane-request-id");
  if (header && /^[\w.-]{8,128}$/.test(header)) return header;
  return `req_${randomUUID()}`;
}

export async function recordAuditEntry(
  input: {
    applicationId: string | null;
    environment?: AuditEnvironment;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
    request?: Request;
    actor?: { id: string; label?: string | null };
  },
  db: Database = getDb(),
) {
  let actor = input.actor;
  if (!actor) {
    // Lazy import keeps this module loadable outside the Next.js runtime
    // (integration tests always pass an explicit actor).
    const { auth } = await import("@/auth");
    const session = await auth();
    actor = {
      id: session?.user?.id ?? session?.user?.email ?? "unknown-admin",
      label:
        (session?.user as { name?: string } | undefined)?.name ??
        session?.user?.email ??
        null,
    };
  }

  const [entry] = await db
    .insert(operatorAuditLog)
    .values({
      id: `audit_${randomUUID()}`,
      applicationId: input.applicationId,
      environment: input.environment ?? null,
      actorType: "admin_session",
      actorId: actor.id,
      actorLabel: actor.label ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      correlationId: correlationIdFrom(input.request),
      metadata: redactAuditMetadata(input.metadata ?? {}),
    })
    .returning();
  return entry;
}

export async function listAuditEntries(
  applicationId: string,
  filters: {
    action?: string;
    actor?: string;
    resourceType?: string;
    environment?: "test" | "live";
    from?: Date;
    to?: Date;
    limit?: number;
  } = {},
  db: Database = getDb(),
) {
  return db
    .select()
    .from(operatorAuditLog)
    .where(
      and(
        eq(operatorAuditLog.applicationId, applicationId),
        filters.action
          ? eq(operatorAuditLog.action, filters.action)
          : undefined,
        filters.actor ? eq(operatorAuditLog.actorId, filters.actor) : undefined,
        filters.resourceType
          ? eq(operatorAuditLog.resourceType, filters.resourceType)
          : undefined,
        filters.environment
          ? eq(operatorAuditLog.environment, filters.environment)
          : undefined,
        filters.from
          ? gte(operatorAuditLog.createdAt, filters.from)
          : undefined,
        filters.to ? lte(operatorAuditLog.createdAt, filters.to) : undefined,
      ),
    )
    .orderBy(desc(operatorAuditLog.createdAt))
    .limit(Math.min(filters.limit ?? 100, 250));
}
