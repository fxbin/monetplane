import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { customerReadTokens } from "./read-token-schema";
import { applicationCustomers } from "./schema";

/**
 * Short-lived, customer-scoped read tokens (#138 end-state for #127).
 *
 * Issued by the application BACKEND through a credential-authenticated
 * endpoint, for ONE application customer; consumed by read endpoints
 * (balances/entitlements) from browsers on branded-host surfaces. The raw
 * token (`mprt_<base64url>`) is shown once and stored only as a SHA-256
 * hash — loss of the tokens table never leaks usable credentials. Tokens
 * carry their own environment and a mandatory expiry; revocation is
 * per-token by id.
 */

export const READ_TOKEN_PREFIX = "mprt_";
export const READ_TOKEN_MIN_TTL_SECONDS = 60;
export const READ_TOKEN_MAX_TTL_SECONDS = 3600;
export const READ_TOKEN_DEFAULT_TTL_SECONDS = 900;

export class CustomerReadTokenError extends Error {
  constructor(message = "Customer read token is invalid or expired") {
    super(message);
    this.name = "CustomerReadTokenError";
  }
}

export class CustomerReadTokenTtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerReadTokenTtlError";
  }
}

function hashReadToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type IssuedCustomerReadToken = {
  id: string;
  token: string;
  expiresAt: Date;
};

export class CustomerReadTokenMismatchError extends Error {
  constructor(
    message = "Customer does not belong to the application bound to this token request",
  ) {
    super(message);
    this.name = "CustomerReadTokenMismatchError";
  }
}

export async function issueCustomerReadToken(
  input: {
    applicationId: string;
    applicationCustomerId: string;
    environment: "test" | "live";
    ttlSeconds?: number;
  },
  db: Database = getDb(),
): Promise<IssuedCustomerReadToken> {
  // Fail-closed app/customer binding check (round-2 review): the two columns
  // are independent FKs — without this, a caller could bind another
  // application's customer row into a token for THIS application.
  const [binding] = await db
    .select({ id: applicationCustomers.id })
    .from(applicationCustomers)
    .where(
      and(
        eq(applicationCustomers.id, input.applicationCustomerId),
        eq(applicationCustomers.applicationId, input.applicationId),
      ),
    )
    .limit(1);
  if (!binding) {
    throw new CustomerReadTokenMismatchError();
  }

  const ttlSeconds = input.ttlSeconds ?? READ_TOKEN_DEFAULT_TTL_SECONDS;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < READ_TOKEN_MIN_TTL_SECONDS ||
    ttlSeconds > READ_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new CustomerReadTokenTtlError(
      `ttlSeconds must be an integer between ${READ_TOKEN_MIN_TTL_SECONDS} and ${READ_TOKEN_MAX_TTL_SECONDS}`,
    );
  }

  const token = `${READ_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const [row] = await db
    .insert(customerReadTokens)
    .values({
      id: `crt_${randomBytes(12).toString("base64url")}`,
      applicationId: input.applicationId,
      applicationCustomerId: input.applicationCustomerId,
      environment: input.environment,
      tokenHash: hashReadToken(token),
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("Failed to issue customer read token");
  return { id: row.id, token, expiresAt: row.expiresAt };
}

export type CustomerReadTokenContext = {
  applicationId: string;
  applicationCustomerId: string;
  externalCustomerId: string;
  environment: "test" | "live";
};

/**
 * Validate a raw `mprt_*` bearer value. The token row carries its own
 * application/environment binding, so cross-application use is impossible by
 * construction — the resolved application comes FROM the token, never from
 * the request.
 */
export async function resolveCustomerReadToken(
  token: string,
  db: Database = getDb(),
): Promise<CustomerReadTokenContext> {
  const [row] = await db
    .select({
      applicationId: customerReadTokens.applicationId,
      applicationCustomerId: customerReadTokens.applicationCustomerId,
      environment: customerReadTokens.environment,
      customerApplicationId: applicationCustomers.applicationId,
    })
    .from(customerReadTokens)
    .innerJoin(
      applicationCustomers,
      eq(applicationCustomers.id, customerReadTokens.applicationCustomerId),
    )
    .where(
      and(
        eq(customerReadTokens.tokenHash, hashReadToken(token)),
        isNull(customerReadTokens.revokedAt),
        gt(customerReadTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) throw new CustomerReadTokenError();
  if (row.customerApplicationId !== row.applicationId) {
    // Fail-closed even though issuance validates the binding: a corrupted or
    // externally-written row must never resolve.
    throw new CustomerReadTokenError();
  }

  const [customer] = await db
    .select({
      externalCustomerId: applicationCustomers.externalCustomerId,
    })
    .from(applicationCustomers)
    .where(eq(applicationCustomers.id, row.applicationCustomerId))
    .limit(1);

  return {
    applicationId: row.applicationId,
    applicationCustomerId: row.applicationCustomerId,
    externalCustomerId: customer?.externalCustomerId ?? "",
    environment: row.environment as "test" | "live",
  };
}

export async function revokeCustomerReadToken(
  input: { applicationId: string; tokenId: string },
  db: Database = getDb(),
): Promise<boolean> {
  const revoked = await db
    .update(customerReadTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(customerReadTokens.id, input.tokenId),
        eq(customerReadTokens.applicationId, input.applicationId),
        isNull(customerReadTokens.revokedAt),
      ),
    )
    .returning({ id: customerReadTokens.id });
  return revoked.length > 0;
}
