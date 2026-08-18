import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { getDb } from "../../db/client";
import { applicationCustomers } from "../customers/schema";
import {
  creditAccounts,
  creditReservations,
  creditTransactions,
} from "./schema";

export type CreditTransactionType =
  | "grant.purchase"
  | "grant.subscription"
  | "grant.promotion"
  | "debit.usage"
  | "reserve.usage"
  | "capture.usage"
  | "release.usage"
  | "refund.usage"
  | "adjustment.admin";

type CreditStore = Pick<
  Database,
  "select" | "insert" | "update" | "execute"
>;

type CreditAccountRow = typeof creditAccounts.$inferSelect;
type CreditTransactionRow = typeof creditTransactions.$inferSelect;
type CreditReservationRow = typeof creditReservations.$inferSelect;

export class CreditCustomerNotFoundError extends Error {
  constructor(message = "Application customer not found for credits") {
    super(message);
    this.name = "CreditCustomerNotFoundError";
  }
}

export class CreditAccountNotFoundError extends Error {
  constructor(message = "Credit account not found") {
    super(message);
    this.name = "CreditAccountNotFoundError";
  }
}

export class InsufficientCreditsError extends Error {
  constructor(message = "Insufficient available credits") {
    super(message);
    this.name = "InsufficientCreditsError";
  }
}

export class CreditIdempotencyConflictError extends Error {
  constructor(
    message = "Credit idempotency key already represents another mutation",
  ) {
    super(message);
    this.name = "CreditIdempotencyConflictError";
  }
}

export class CreditReservationNotFoundError extends Error {
  constructor(message = "Credit reservation not found") {
    super(message);
    this.name = "CreditReservationNotFoundError";
  }
}

export class CreditReservationTerminalStateError extends Error {
  constructor(message = "Credit reservation is already terminal") {
    super(message);
    this.name = "CreditReservationTerminalStateError";
  }
}

function normalizeCreditType(value: string): string {
  const creditType = value.trim().toLowerCase();
  if (!creditType || !/^[a-z0-9][a-z0-9._-]*$/.test(creditType)) {
    throw new Error(
      "Credit type must use lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  return creditType;
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function assertPositiveAmount(amount: number, label = "Credit amount"): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

async function lockIdempotency(
  applicationId: string,
  idempotencyKey: string,
  db: CreditStore,
): Promise<void> {
  const scope = `${applicationId}:${idempotencyKey}`;
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`,
  );
}

async function findTransactionByIdempotency(
  applicationId: string,
  idempotencyKey: string,
  db: CreditStore,
): Promise<CreditTransactionRow | undefined> {
  const [transaction] = await db
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.applicationId, applicationId),
        eq(creditTransactions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return transaction;
}

function assertExistingTransaction(
  transaction: CreditTransactionRow,
  expected: {
    type: CreditTransactionType;
    amount: number;
    applicationCustomerId: string;
    sourceType: string;
    sourceId: string;
  },
): void {
  if (
    transaction.type !== expected.type ||
    transaction.amount !== expected.amount ||
    transaction.applicationCustomerId !== expected.applicationCustomerId ||
    transaction.sourceType !== expected.sourceType ||
    transaction.sourceId !== expected.sourceId
  ) {
    throw new CreditIdempotencyConflictError();
  }
}

async function resolveApplicationCustomerId(
  applicationId: string,
  externalCustomerId: string,
  db: CreditStore,
): Promise<string> {
  const normalizedExternalId = normalizeRequired(
    externalCustomerId,
    "External customer ID",
  );
  const [mapping] = await db
    .select({ id: applicationCustomers.id })
    .from(applicationCustomers)
    .where(
      and(
        eq(applicationCustomers.applicationId, applicationId),
        eq(applicationCustomers.externalCustomerId, normalizedExternalId),
      ),
    )
    .limit(1);
  if (!mapping) throw new CreditCustomerNotFoundError();
  return mapping.id;
}

async function findAccount(
  applicationId: string,
  applicationCustomerId: string,
  creditType: string,
  db: CreditStore,
): Promise<CreditAccountRow | undefined> {
  const [account] = await db
    .select()
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.applicationId, applicationId),
        eq(creditAccounts.applicationCustomerId, applicationCustomerId),
        eq(creditAccounts.creditType, creditType),
      ),
    )
    .limit(1);
  return account;
}

async function ensureAccount(
  applicationId: string,
  applicationCustomerId: string,
  creditType: string,
  db: CreditStore,
): Promise<CreditAccountRow> {
  await db
    .insert(creditAccounts)
    .values({
      id: `credit_${randomUUID()}`,
      applicationId,
      applicationCustomerId,
      creditType,
    })
    .onConflictDoNothing({
      target: [
        creditAccounts.applicationId,
        creditAccounts.applicationCustomerId,
        creditAccounts.creditType,
      ],
    });

  const account = await findAccount(
    applicationId,
    applicationCustomerId,
    creditType,
    db,
  );
  if (!account) throw new Error("Failed to create or resolve credit account");
  return account;
}

async function appendTransaction(
  input: {
    applicationId: string;
    applicationCustomerId: string;
    creditAccountId: string;
    type: CreditTransactionType;
    amount: number;
    availableAfter: number;
    reservedAfter: number;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  db: CreditStore,
): Promise<CreditTransactionRow> {
  const [transaction] = await db
    .insert(creditTransactions)
    .values({
      id: `ctx_${randomUUID()}`,
      applicationId: input.applicationId,
      applicationCustomerId: input.applicationCustomerId,
      creditAccountId: input.creditAccountId,
      type: input.type,
      amount: input.amount,
      availableAfter: input.availableAfter,
      reservedAfter: input.reservedAfter,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ?? {},
    })
    .returning();
  if (!transaction) throw new Error("Failed to append credit transaction");
  return transaction;
}

export async function getCreditBalanceForApplicationCustomer(
  applicationId: string,
  applicationCustomerId: string,
  creditTypeInput: string,
  db: CreditStore = getDb(),
) {
  const creditType = normalizeCreditType(creditTypeInput);
  const account = await findAccount(
    applicationId,
    applicationCustomerId,
    creditType,
    db,
  );
  return {
    creditType,
    available: account?.availableBalance ?? 0,
    reserved: account?.reservedBalance ?? 0,
  };
}

export async function getCreditBalance(
  applicationId: string,
  externalCustomerId: string,
  creditType: string,
  db: CreditStore = getDb(),
) {
  const applicationCustomerId = await resolveApplicationCustomerId(
    applicationId,
    externalCustomerId,
    db,
  );
  return getCreditBalanceForApplicationCustomer(
    applicationId,
    applicationCustomerId,
    creditType,
    db,
  );
}

export async function grantCreditsInTransaction(
  input: {
    applicationId: string;
    applicationCustomerId: string;
    creditType: string;
    amount: number;
    transactionType:
      | "grant.purchase"
      | "grant.subscription"
      | "grant.promotion"
      | "adjustment.admin";
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  db: CreditStore,
) {
  const creditType = normalizeCreditType(input.creditType);
  assertPositiveAmount(input.amount);
  const sourceType = normalizeRequired(input.sourceType, "Credit source type");
  const sourceId = normalizeRequired(input.sourceId, "Credit source ID");
  const idempotencyKey = normalizeRequired(
    input.idempotencyKey,
    "Credit idempotency key",
  );

  await lockIdempotency(input.applicationId, idempotencyKey, db);
  const existing = await findTransactionByIdempotency(
    input.applicationId,
    idempotencyKey,
    db,
  );
  if (existing) {
    assertExistingTransaction(existing, {
      type: input.transactionType,
      amount: input.amount,
      applicationCustomerId: input.applicationCustomerId,
      sourceType,
      sourceId,
    });
    return { transaction: existing, duplicate: true };
  }

  const account = await ensureAccount(
    input.applicationId,
    input.applicationCustomerId,
    creditType,
    db,
  );
  const [updated] = await db
    .update(creditAccounts)
    .set({
      availableBalance: sql`${creditAccounts.availableBalance} + ${input.amount}`,
      version: sql`${creditAccounts.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(creditAccounts.id, account.id))
    .returning();
  if (!updated) throw new Error("Failed to update credit balance for grant");

  const transaction = await appendTransaction(
    {
      applicationId: input.applicationId,
      applicationCustomerId: input.applicationCustomerId,
      creditAccountId: updated.id,
      type: input.transactionType,
      amount: input.amount,
      availableAfter: updated.availableBalance,
      reservedAfter: updated.reservedBalance,
      sourceType,
      sourceId,
      idempotencyKey,
      metadata: input.metadata,
    },
    db,
  );
  return { transaction, duplicate: false };
}

export async function grantCredits(
  input: Parameters<typeof grantCreditsInTransaction>[0],
  db: Database = getDb(),
) {
  return db.transaction((tx) => grantCreditsInTransaction(input, tx));
}

async function debitCreditsForApplicationCustomerInTransaction(
  input: {
    applicationId: string;
    applicationCustomerId: string;
    creditType: string;
    amount: number;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  db: CreditStore,
) {
  const creditType = normalizeCreditType(input.creditType);
  assertPositiveAmount(input.amount);
  const sourceType = normalizeRequired(input.sourceType, "Credit source type");
  const sourceId = normalizeRequired(input.sourceId, "Credit source ID");
  const idempotencyKey = normalizeRequired(
    input.idempotencyKey,
    "Credit idempotency key",
  );
  await lockIdempotency(input.applicationId, idempotencyKey, db);

  const existing = await findTransactionByIdempotency(
    input.applicationId,
    idempotencyKey,
    db,
  );
  if (existing) {
    assertExistingTransaction(existing, {
      type: "debit.usage",
      amount: -input.amount,
      applicationCustomerId: input.applicationCustomerId,
      sourceType,
      sourceId,
    });
    return { transaction: existing, duplicate: true };
  }

  const account = await findAccount(
    input.applicationId,
    input.applicationCustomerId,
    creditType,
    db,
  );
  if (!account) throw new InsufficientCreditsError();

  const [updated] = await db
    .update(creditAccounts)
    .set({
      availableBalance: sql`${creditAccounts.availableBalance} - ${input.amount}`,
      version: sql`${creditAccounts.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditAccounts.id, account.id),
        gte(creditAccounts.availableBalance, input.amount),
      ),
    )
    .returning();
  if (!updated) throw new InsufficientCreditsError();

  const transaction = await appendTransaction(
    {
      applicationId: input.applicationId,
      applicationCustomerId: input.applicationCustomerId,
      creditAccountId: updated.id,
      type: "debit.usage",
      amount: -input.amount,
      availableAfter: updated.availableBalance,
      reservedAfter: updated.reservedBalance,
      sourceType,
      sourceId,
      idempotencyKey,
      metadata: input.metadata,
    },
    db,
  );
  return { transaction, duplicate: false };
}

export async function debitCredits(
  input: {
    applicationId: string;
    externalCustomerId: string;
    creditType: string;
    amount: number;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  return db.transaction(async (tx) => {
    const applicationCustomerId = await resolveApplicationCustomerId(
      input.applicationId,
      input.externalCustomerId,
      tx,
    );
    return debitCreditsForApplicationCustomerInTransaction(
      { ...input, applicationCustomerId },
      tx,
    );
  });
}

export async function refundCredits(
  input: {
    applicationId: string;
    externalCustomerId: string;
    creditType: string;
    amount: number;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  return db.transaction(async (tx) => {
    const applicationCustomerId = await resolveApplicationCustomerId(
      input.applicationId,
      input.externalCustomerId,
      tx,
    );
    return grantCreditsInTransaction(
      {
        applicationId: input.applicationId,
        applicationCustomerId,
        creditType: input.creditType,
        amount: input.amount,
        transactionType: "adjustment.admin",
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: input.idempotencyKey,
        metadata: { reason: "refund.usage", ...(input.metadata ?? {}) },
      },
      tx,
    );
  });
}

export async function reserveCredits(
  input: {
    applicationId: string;
    externalCustomerId: string;
    creditType: string;
    amount: number;
    referenceType: string;
    referenceId: string;
    idempotencyKey: string;
    expiresAt?: Date | null;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  return db.transaction(async (tx) => {
    const creditType = normalizeCreditType(input.creditType);
    assertPositiveAmount(input.amount, "Reservation amount");
    const referenceType = normalizeRequired(
      input.referenceType,
      "Reservation reference type",
    );
    const referenceId = normalizeRequired(
      input.referenceId,
      "Reservation reference ID",
    );
    const idempotencyKey = normalizeRequired(
      input.idempotencyKey,
      "Credit idempotency key",
    );
    const applicationCustomerId = await resolveApplicationCustomerId(
      input.applicationId,
      input.externalCustomerId,
      tx,
    );

    await lockIdempotency(input.applicationId, idempotencyKey, tx);
    const [existingReservation] = await tx
      .select()
      .from(creditReservations)
      .where(
        and(
          eq(creditReservations.applicationId, input.applicationId),
          eq(creditReservations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existingReservation) {
      if (
        existingReservation.applicationCustomerId !== applicationCustomerId ||
        existingReservation.reservedAmount !== input.amount ||
        existingReservation.referenceType !== referenceType ||
        existingReservation.referenceId !== referenceId
      ) {
        throw new CreditIdempotencyConflictError();
      }
      return { reservation: existingReservation, duplicate: true };
    }

    const account = await findAccount(
      input.applicationId,
      applicationCustomerId,
      creditType,
      tx,
    );
    if (!account) throw new InsufficientCreditsError();

    const [updated] = await tx
      .update(creditAccounts)
      .set({
        availableBalance: sql`${creditAccounts.availableBalance} - ${input.amount}`,
        reservedBalance: sql`${creditAccounts.reservedBalance} + ${input.amount}`,
        version: sql`${creditAccounts.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditAccounts.id, account.id),
          gte(creditAccounts.availableBalance, input.amount),
        ),
      )
      .returning();
    if (!updated) throw new InsufficientCreditsError();

    const [reservation] = await tx
      .insert(creditReservations)
      .values({
        id: `cres_${randomUUID()}`,
        applicationId: input.applicationId,
        applicationCustomerId,
        creditAccountId: updated.id,
        reservedAmount: input.amount,
        referenceType,
        referenceId,
        idempotencyKey,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    if (!reservation) throw new Error("Failed to create credit reservation");

    await appendTransaction(
      {
        applicationId: input.applicationId,
        applicationCustomerId,
        creditAccountId: updated.id,
        type: "reserve.usage",
        amount: -input.amount,
        availableAfter: updated.availableBalance,
        reservedAfter: updated.reservedBalance,
        sourceType: "reservation",
        sourceId: reservation.id,
        idempotencyKey,
        metadata: {
          referenceType,
          referenceId,
          ...(input.metadata ?? {}),
        },
      },
      tx,
    );

    return { reservation, duplicate: false };
  });
}

async function lockReservation(
  applicationId: string,
  reservationId: string,
  db: CreditStore,
): Promise<CreditReservationRow> {
  const [reservation] = await db
    .select()
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.id, reservationId),
        eq(creditReservations.applicationId, applicationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!reservation) throw new CreditReservationNotFoundError();
  return reservation;
}

export async function captureReservation(
  input: {
    applicationId: string;
    reservationId: string;
    amount: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  return db.transaction(async (tx) => {
    assertPositiveAmount(input.amount, "Capture amount");
    const idempotencyKey = normalizeRequired(
      input.idempotencyKey,
      "Credit idempotency key",
    );
    await lockIdempotency(input.applicationId, idempotencyKey, tx);

    const existing = await findTransactionByIdempotency(
      input.applicationId,
      idempotencyKey,
      tx,
    );
    if (existing) {
      if (
        existing.type !== "capture.usage" ||
        existing.sourceId !== input.reservationId ||
        existing.amount !== -input.amount
      ) {
        throw new CreditIdempotencyConflictError();
      }
      return { transaction: existing, duplicate: true };
    }

    const reservation = await lockReservation(
      input.applicationId,
      input.reservationId,
      tx,
    );
    if (reservation.status === "captured") {
      return { reservation, duplicate: true, terminal: true };
    }
    if (reservation.status !== "active") {
      throw new CreditReservationTerminalStateError(
        `Cannot capture a ${reservation.status} reservation`,
      );
    }
    if (input.amount > reservation.reservedAmount) {
      throw new Error("Capture amount cannot exceed reserved amount");
    }

    const unused = reservation.reservedAmount - input.amount;
    const [account] = await tx
      .update(creditAccounts)
      .set({
        availableBalance: sql`${creditAccounts.availableBalance} + ${unused}`,
        reservedBalance: sql`${creditAccounts.reservedBalance} - ${reservation.reservedAmount}`,
        version: sql`${creditAccounts.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditAccounts.id, reservation.creditAccountId),
          gte(creditAccounts.reservedBalance, reservation.reservedAmount),
        ),
      )
      .returning();
    if (!account) throw new Error("Reserved credit balance is inconsistent");

    const [updatedReservation] = await tx
      .update(creditReservations)
      .set({
        status: "captured",
        capturedAmount: input.amount,
        updatedAt: new Date(),
      })
      .where(eq(creditReservations.id, reservation.id))
      .returning();
    if (!updatedReservation) throw new Error("Failed to capture reservation");

    const transaction = await appendTransaction(
      {
        applicationId: input.applicationId,
        applicationCustomerId: reservation.applicationCustomerId,
        creditAccountId: account.id,
        type: "capture.usage",
        amount: -input.amount,
        availableAfter: account.availableBalance,
        reservedAfter: account.reservedBalance,
        sourceType: "reservation",
        sourceId: reservation.id,
        idempotencyKey,
        metadata: {
          reservedAmount: reservation.reservedAmount,
          releasedUnused: unused,
          ...(input.metadata ?? {}),
        },
      },
      tx,
    );

    return {
      reservation: updatedReservation,
      transaction,
      duplicate: false,
    };
  });
}

export async function releaseReservation(
  input: {
    applicationId: string;
    reservationId: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
) {
  return db.transaction(async (tx) => {
    const idempotencyKey = normalizeRequired(
      input.idempotencyKey,
      "Credit idempotency key",
    );
    await lockIdempotency(input.applicationId, idempotencyKey, tx);

    const existing = await findTransactionByIdempotency(
      input.applicationId,
      idempotencyKey,
      tx,
    );
    if (existing) {
      if (
        existing.type !== "release.usage" ||
        existing.sourceId !== input.reservationId
      ) {
        throw new CreditIdempotencyConflictError();
      }
      return { transaction: existing, duplicate: true };
    }

    const reservation = await lockReservation(
      input.applicationId,
      input.reservationId,
      tx,
    );
    if (reservation.status === "released") {
      return { reservation, duplicate: true, terminal: true };
    }
    if (reservation.status !== "active") {
      throw new CreditReservationTerminalStateError(
        `Cannot release a ${reservation.status} reservation`,
      );
    }

    const [account] = await tx
      .update(creditAccounts)
      .set({
        availableBalance: sql`${creditAccounts.availableBalance} + ${reservation.reservedAmount}`,
        reservedBalance: sql`${creditAccounts.reservedBalance} - ${reservation.reservedAmount}`,
        version: sql`${creditAccounts.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditAccounts.id, reservation.creditAccountId),
          gte(creditAccounts.reservedBalance, reservation.reservedAmount),
        ),
      )
      .returning();
    if (!account) throw new Error("Reserved credit balance is inconsistent");

    const [updatedReservation] = await tx
      .update(creditReservations)
      .set({ status: "released", updatedAt: new Date() })
      .where(eq(creditReservations.id, reservation.id))
      .returning();
    if (!updatedReservation) throw new Error("Failed to release reservation");

    const transaction = await appendTransaction(
      {
        applicationId: input.applicationId,
        applicationCustomerId: reservation.applicationCustomerId,
        creditAccountId: account.id,
        type: "release.usage",
        amount: reservation.reservedAmount,
        availableAfter: account.availableBalance,
        reservedAfter: account.reservedBalance,
        sourceType: "reservation",
        sourceId: reservation.id,
        idempotencyKey,
        metadata: input.metadata,
      },
      tx,
    );

    return {
      reservation: updatedReservation,
      transaction,
      duplicate: false,
    };
  });
}
