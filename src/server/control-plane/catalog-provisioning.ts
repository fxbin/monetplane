import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import {
  beginProvision,
  CatalogProvisionError,
  type CatalogProvisionErrorCode,
  finishProvision,
  type ProvisionBeginResult,
} from "@/modules/providers/catalog-provisioning";
import {
  ProviderOperationError,
  UnsupportedProviderCapabilityError,
} from "@/modules/providers/contract";
import {
  createProviderCatalogProduct,
  getProviderCapabilities,
  getProviderCatalogProduct,
} from "@/modules/providers/runtime";
import {
  getProviderConnection,
  ProviderConnectionNotFoundError,
} from "@/modules/providers/service";
import type { ConsoleEnvironment } from "./context";

/**
 * Console orchestration for provider product provisioning (#156).
 *
 * The state machine (catalog-provisioning.ts) owns every row transition;
 * this layer owns the external calls — strictly BETWEEN transitions, never
 * inside a transaction — plus a bounded, same-idempotency-key retry for
 * 429 rate limits only. Timeouts, 5xx, and transport failures are UNCERTAIN
 * (the create may have landed) and are parked as needs_reconciliation for
 * the audited recovery path: the operator locates the product at the
 * provider and links it (adoption), or explicitly fails the intent and
 * retries. Nothing uncertain is ever auto-re-POSTed.
 */

export type CatalogProvisionInput = {
  providerConnectionId: string;
  monetplanePriceId: string;
  name?: string;
  description?: string | null;
  taxCategory?: string | null;
};

export type ProvisionAuditEntry = {
  action: string;
  resourceId: string;
  metadata: Record<string, unknown>;
};

const PROVISION_STATUS_BY_CODE: Record<CatalogProvisionErrorCode, number> = {
  invalid_input: 400,
  connection_not_found: 404,
  connection_revoked: 400,
  connection_environment_mismatch: 400,
  price_not_found: 404,
  price_inactive: 400,
  provider_unsupported: 400,
  legacy_mapping_conflict: 400,
  provision_in_progress: 409,
  provision_needs_attention: 409,
  provision_create_rejected: 400,
  provision_post_create_mismatch: 409,
};

const PROVISION_MESSAGE_KEY_BY_CODE: Record<CatalogProvisionErrorCode, string> =
  {
    invalid_input: "provisionInvalidInput",
    connection_not_found: "catalogLinkConnectionNotFound",
    connection_revoked: "catalogLinkConnectionRevoked",
    connection_environment_mismatch: "catalogLinkEnvironmentMismatch",
    price_not_found: "catalogLinkPriceNotFound",
    price_inactive: "catalogLinkPriceInactive",
    provider_unsupported: "provisionProviderUnsupported",
    legacy_mapping_conflict: "provisionLegacyConflict",
    provision_in_progress: "provisionInProgress",
    provision_needs_attention: "provisionNeedsAttention",
    provision_create_rejected: "provisionCreateRejected",
    provision_post_create_mismatch: "provisionPostCreateMismatch",
  };

type AdminErrorsDictionary = Record<string, unknown>;

/** Routes import this; Next.js route files may only export HTTP handlers. */
export function catalogProvisionErrorResponse(
  error: CatalogProvisionError,
  adminErrors: AdminErrorsDictionary,
): NextResponse {
  const messageKey = PROVISION_MESSAGE_KEY_BY_CODE[error.code];
  const message = messageKey ? adminErrors[messageKey] : undefined;
  return NextResponse.json(
    {
      error: typeof message === "string" ? message : error.message,
      code: error.code,
      details: error.details,
    },
    { status: PROVISION_STATUS_BY_CODE[error.code] ?? 400 },
  );
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

export type ProvisionFromConsoleResult =
  | {
      outcome: "created";
      mapping: ProvisionBeginResult["mapping"];
      providerProductId: string;
    }
  | { outcome: "already_synced"; mapping: ProvisionBeginResult["mapping"] };

/**
 * Provision (or report) a provider product for a MonetPlane price. Every
 * observable outcome is audited: provisioned / provision_failed /
 * provision_uncertain / provision_stale / provision_rejected.
 */
export async function provisionProviderCatalogProductFromConsole(
  applicationId: string,
  environment: ConsoleEnvironment,
  input: CatalogProvisionInput,
  audit: (entry: ProvisionAuditEntry) => Promise<void>,
  options: { retryDelaysMs?: number[] } = {},
): Promise<ProvisionFromConsoleResult> {
  let auditResourceId = `price:${input.monetplanePriceId}`;
  const baseAuditMetadata = {
    providerConnectionId: input.providerConnectionId,
    monetplanePriceId: input.monetplanePriceId,
    environment,
  };
  // Outcome audits (provisioned/failed/uncertain/stale) own the record for
  // their attempt; the catch below only audits errors that never reached
  // an outcome (validation, in-progress, needs-attention from begin).
  let outcomeAudited = false;
  const auditOutcome = async (entry: ProvisionAuditEntry) => {
    outcomeAudited = true;
    await audit(entry);
  };

  try {
    // Capability pre-flight BEFORE any intent row exists: a provider
    // without catalog provisioning must never leave a failed mapping
    // behind (PR #160 review, F2) — reject deterministically and
    // statelessly. Capability resolution failure also fails closed.
    const connection = await getProviderConnection(
      applicationId,
      input.providerConnectionId,
    );
    if (connection) {
      try {
        const capabilities = await getProviderCapabilities(
          applicationId,
          connection.id,
        );
        if (!capabilities.catalog_provisioning) {
          throw new CatalogProvisionError(
            `Provider ${connection.provider} does not support automatic product creation; link an existing product instead`,
            "provider_unsupported",
          );
        }
      } catch (cause) {
        if (cause instanceof CatalogProvisionError) throw cause;
        throw new CatalogProvisionError(
          "Provider capabilities could not be resolved; refusing to create",
          "provider_unsupported",
        );
      }
    }

    const begin = await beginProvision(
      {
        applicationId,
        environment,
        providerConnectionId: input.providerConnectionId,
        monetplanePriceId: input.monetplanePriceId,
        name: input.name,
        description: input.description,
        taxCategory: input.taxCategory,
      },
      getDb(),
    );

    if (begin.outcome === "already_synced") {
      return { outcome: "already_synced", mapping: begin.mapping };
    }

    auditResourceId = begin.mapping.id;
    if (begin.outcome === "stale_parked") {
      await auditOutcome({
        action: "provider_catalog.provision_stale",
        resourceId: begin.mapping.id,
        metadata: {
          ...baseAuditMetadata,
          reason: "stale in-flight intent parked for manual recovery",
        },
      });
      throw new CatalogProvisionError(
        "A previous provisioning attempt crashed with an unknown outcome; the intent now needs attention — find the product at the provider and link it to adopt it, or mark the intent failed and retry",
        "provision_needs_attention",
      );
    }

    // External create — outside any transaction, between two row
    // transitions. 429 rate limits are retried with the SAME idempotency
    // key (bounded); everything else is classified below. Deterministic
    // rejections (4xx incl. exhausted 429, adapter pre-flight violations,
    // unsupported provider) park the intent as failed; timeouts, 5xx, and
    // transport failures are UNCERTAIN and park it as
    // needs_reconciliation.
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    let createResult:
      | { kind: "created"; providerProductId: string }
      | { kind: "rejected"; message: string; code?: CatalogProvisionErrorCode }
      | { kind: "uncertain"; message: string };
    try {
      let attempt = 0;
      for (;;) {
        try {
          const created = await createProviderCatalogProduct(
            applicationId,
            input.providerConnectionId,
            begin.input,
            getDb(),
          );
          createResult = { kind: "created", ...created };
          break;
        } catch (cause) {
          if (
            cause instanceof ProviderOperationError &&
            cause.status === 429 &&
            attempt < retryDelays.length
          ) {
            const delay = retryDelays[attempt];
            attempt += 1;
            if (delay) {
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
            continue;
          }
          throw cause;
        }
      }
    } catch (cause) {
      if (cause instanceof UnsupportedProviderCapabilityError) {
        createResult = {
          kind: "rejected",
          message: cause.message,
          code: "provider_unsupported",
        };
      } else if (cause instanceof ProviderConnectionNotFoundError) {
        // Connection revoked/deleted between begin and create: nothing was
        // sent — deterministic, parks failed instead of needs_reconciliation.
        createResult = { kind: "rejected", message: cause.message };
      } else if (cause instanceof ProviderOperationError) {
        createResult =
          cause.failureKind === "rejected"
            ? {
                kind: "rejected",
                message: cause.message,
                code: /does not support catalog product creation/i.test(
                  cause.message,
                )
                  ? "provider_unsupported"
                  : undefined,
              }
            : { kind: "uncertain", message: cause.message };
      } else {
        createResult = {
          kind: "uncertain",
          message: cause instanceof Error ? cause.message : "unknown failure",
        };
      }
    }

    let finish: Awaited<ReturnType<typeof finishProvision>>;
    try {
      finish = await finishProvision(
        {
          applicationId,
          environment,
          providerConnectionId: input.providerConnectionId,
          monetplanePriceId: input.monetplanePriceId,
          mappingId: begin.mapping.id,
          attemptToken: begin.attemptToken,
        },
        createResult,
        async (providerProductId) =>
          getProviderCatalogProduct(
            applicationId,
            input.providerConnectionId,
            { providerProductId },
            getDb(),
          ),
        getDb(),
      );
    } catch (cause) {
      if (
        cause instanceof CatalogProvisionError &&
        cause.code === "provision_post_create_mismatch"
      ) {
        // A product EXISTS but does not match — that is an uncertain,
        // human-parked outcome, not a rejected request (review F3).
        await auditOutcome({
          action: "provider_catalog.provision_uncertain",
          resourceId: begin.mapping.id,
          metadata: {
            ...baseAuditMetadata,
            reason: "post-create verification mismatch",
            details: cause.details,
          },
        });
      }
      throw cause;
    }

    if (finish.outcome === "synced") {
      await auditOutcome({
        action: "provider_catalog.provisioned",
        resourceId: finish.mapping.id,
        metadata: {
          ...baseAuditMetadata,
          providerProductId: finish.mapping.providerProductId,
          source: finish.mapping.source,
        },
      });
      return {
        outcome: "created",
        mapping: finish.mapping,
        providerProductId: finish.mapping.providerProductId ?? "",
      };
    }
    if (finish.outcome === "failed") {
      await auditOutcome({
        action: "provider_catalog.provision_failed",
        resourceId: finish.mapping.id,
        metadata: {
          ...baseAuditMetadata,
          reason:
            createResult.kind === "rejected" ? createResult.message : "unknown",
        },
      });
      throw new CatalogProvisionError(
        createResult.kind === "rejected"
          ? createResult.message
          : "Provider product creation failed",
        (createResult.kind === "rejected" && createResult.code) ||
          "provision_create_rejected",
      );
    }
    // uncertain — the create may have landed; never auto-retried.
    await auditOutcome({
      action: "provider_catalog.provision_uncertain",
      resourceId: finish.mapping.id,
      metadata: {
        ...baseAuditMetadata,
        reason:
          createResult.kind === "uncertain"
            ? createResult.message
            : "post-create verification failed",
        parkedProviderProductId: finish.mapping.providerProductId,
      },
    });
    throw new CatalogProvisionError(
      "The create request has an uncertain outcome (the product may already exist at the provider). Find the product there and link it to adopt it, or mark the intent failed and retry",
      "provision_needs_attention",
    );
  } catch (error) {
    if (error instanceof CatalogProvisionError && !outcomeAudited) {
      await audit({
        action: "provider_catalog.provision_rejected",
        resourceId: auditResourceId,
        metadata: {
          ...baseAuditMetadata,
          reason: error.code,
          details: error.details,
        },
      });
    }
    throw error;
  }
}
