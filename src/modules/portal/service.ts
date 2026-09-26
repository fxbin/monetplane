import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  applicationBranding,
  applications,
} from "@/modules/applications/schema";
import { assertAllowedCallbackUrl } from "@/modules/applications/service";
import { applicationCustomers } from "@/modules/customers/schema";
import { findApplicationCustomer } from "@/modules/customers/service";
import { portalSessions } from "@/modules/portal/schema";

/**
 * Customer portal session service (#71).
 *
 * Lifecycle and authorization for hosted portal sessions. The session row is
 * the ONLY source of application/customer/environment scoping for every
 * portal read and action — nothing is accepted from the browser beyond the
 * opaque token.
 */

export const PORTAL_SESSION_TTL_MS = 30 * 60 * 1000;

export class PortalServiceError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "PortalServiceError";
    this.status = status;
    this.code = code;
  }
}

export type PortalEnvironment = "test" | "live";

export type PortalSessionContext = {
  sessionId: string;
  applicationId: string;
  applicationCustomerId: string;
  environment: PortalEnvironment;
  returnUrl: string | null;
  expiresAt: Date;
  application: {
    id: string;
    slug: string;
    name: string;
    status: string;
  };
  branding: {
    displayName: string;
    logoUrl: string | null;
    primaryColor: string | null;
    supportEmail: string | null;
  };
  customer: {
    externalCustomerId: string;
    email: string | null;
  };
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The return URL is stored on the session at creation time, validated against
 * the application's registered callback origins — portal flows can never
 * become open redirects.
 */
export async function createPortalSession(input: {
  applicationId: string;
  externalCustomerId: string;
  environment: PortalEnvironment;
  returnUrl?: string;
}): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  const customer = await findApplicationCustomer(
    input.applicationId,
    input.externalCustomerId,
  );
  if (!customer) {
    throw new PortalServiceError(
      "No matching customer for this application",
      404,
      "customer_not_found",
    );
  }

  let returnUrl: string | undefined;
  if (input.returnUrl !== undefined) {
    if (typeof input.returnUrl !== "string" || !input.returnUrl.trim()) {
      throw new PortalServiceError(
        "returnUrl must be a URL string when provided",
        400,
        "invalid_return_url",
      );
    }
    try {
      returnUrl = await assertAllowedCallbackUrl(
        input.applicationId,
        input.returnUrl.trim(),
      );
    } catch {
      throw new PortalServiceError(
        "returnUrl origin is not registered for this application",
        400,
        "return_url_not_allowed",
      );
    }
  }

  const token = `mptok_${randomBytes(32).toString("base64url")}`;
  const sessionId = `psess_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + PORTAL_SESSION_TTL_MS);

  await getDb()
    .insert(portalSessions)
    .values({
      id: sessionId,
      applicationId: input.applicationId,
      applicationCustomerId: customer.id,
      environment: input.environment,
      tokenHash: hashToken(token),
      status: "active",
      returnUrl: returnUrl ?? null,
      expiresAt,
    });

  return { sessionId, token, expiresAt };
}

/**
 * Resolve a portal session from the raw browser-supplied token. Fails closed
 * on unknown, revoked, or expired tokens, and on inactive applications.
 */
export async function resolvePortalSession(
  token: string,
): Promise<PortalSessionContext> {
  if (typeof token !== "string" || !token.startsWith("mptok_")) {
    throw new PortalServiceError(
      "This portal session is not valid",
      401,
      "portal_session_invalid",
    );
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(portalSessions)
    .where(eq(portalSessions.tokenHash, hashToken(token)))
    .limit(1);

  if (!row || row.status === "revoked") {
    throw new PortalServiceError(
      "This portal session is not valid",
      401,
      "portal_session_invalid",
    );
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new PortalServiceError(
      "This portal session has expired. Start a new session from the application.",
      401,
      "portal_session_expired",
    );
  }

  const [application] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, row.applicationId))
    .limit(1);
  if (!application || application.status !== "active") {
    throw new PortalServiceError(
      "This portal session is not valid",
      401,
      "portal_session_invalid",
    );
  }

  const [customer] = await db
    .select()
    .from(applicationCustomers)
    .where(eq(applicationCustomers.id, row.applicationCustomerId))
    .limit(1);
  if (!customer || customer.applicationId !== row.applicationId) {
    throw new PortalServiceError(
      "This portal session is not valid",
      401,
      "portal_session_invalid",
    );
  }

  const [branding] = await db
    .select()
    .from(applicationBranding)
    .where(eq(applicationBranding.applicationId, application.id))
    .limit(1);

  await db
    .update(portalSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(portalSessions.id, row.id));

  return {
    sessionId: row.id,
    applicationId: row.applicationId,
    applicationCustomerId: row.applicationCustomerId,
    environment: row.environment as PortalEnvironment,
    returnUrl: row.returnUrl,
    expiresAt: row.expiresAt,
    application: {
      id: application.id,
      slug: application.slug,
      name: application.name,
      status: application.status,
    },
    branding: {
      displayName: branding?.displayName ?? application.name,
      logoUrl: branding?.logoUrl ?? null,
      primaryColor: branding?.primaryColor ?? null,
      supportEmail: branding?.supportEmail ?? null,
    },
    customer: {
      externalCustomerId: customer.externalCustomerId,
      email: customer.email,
    },
  };
}

/** Revoke an active session (application backends can end portal access early). */
export async function revokePortalSession(input: {
  applicationId: string;
  sessionId: string;
}): Promise<void> {
  const result = await getDb()
    .update(portalSessions)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(
      and(
        eq(portalSessions.id, input.sessionId),
        eq(portalSessions.applicationId, input.applicationId),
        eq(portalSessions.status, "active"),
      ),
    )
    .returning();
  if (result.length === 0) {
    throw new PortalServiceError(
      "Portal session not found or already ended",
      404,
      "not_found",
    );
  }
}
