import type {
  NormalizedPayment,
  NormalizedSubscription,
  ProviderCapabilities,
  ProviderCapability,
  ProviderMode,
} from "@/modules/providers/contract";
import {
  getProviderCapabilities,
  getProviderPayment,
  getProviderSubscription,
} from "@/modules/providers/runtime";
import { getProviderConnection } from "@/modules/providers/service";
import { getProviderSetup } from "@/modules/providers/setup";

export type ConsoleProviderCapability = {
  key: ProviderCapability;
  supported: boolean;
};

export type ConsoleProviderDiagnosticKind =
  | "configuration"
  | "payment"
  | "subscription";

export type ConsoleProviderDiagnosticResult = {
  kind: ConsoleProviderDiagnosticKind;
  status: "passed";
  checkedAt: string;
  provider: string;
  connectionId: string;
  environment: ProviderMode;
  summary: string;
  capabilities?: ConsoleProviderCapability[];
  payment?: NormalizedPayment;
  subscription?: NormalizedSubscription;
};

export class ConsoleProviderDiagnosticError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "revoked"
      | "invalid_input"
      | "provider_error",
  ) {
    super(message);
    this.name = "ConsoleProviderDiagnosticError";
  }
}

function capabilityRows(
  capabilities: ProviderCapabilities,
): ConsoleProviderCapability[] {
  return (
    Object.entries(capabilities) as Array<[ProviderCapability, boolean]>
  ).map(([key, supported]) => ({ key, supported }));
}

async function requireDiagnosticConnection(
  applicationId: string,
  connectionId: string,
  environment: ProviderMode,
) {
  const connection = await getProviderConnection(applicationId, connectionId);
  if (!connection || connection.mode !== environment) {
    throw new ConsoleProviderDiagnosticError(
      "Provider connection not found in the selected project/environment",
      "not_found",
    );
  }
  if (connection.status !== "active") {
    throw new ConsoleProviderDiagnosticError(
      "Provider diagnostics are disabled for revoked connections",
      "revoked",
    );
  }
  return connection;
}

export async function runConsoleProviderDiagnostic(
  applicationId: string,
  connectionId: string,
  environment: ProviderMode,
  input: {
    kind: ConsoleProviderDiagnosticKind;
    providerResourceId?: string;
  },
): Promise<ConsoleProviderDiagnosticResult> {
  const connection = await requireDiagnosticConnection(
    applicationId,
    connectionId,
    environment,
  );
  const checkedAt = new Date().toISOString();

  try {
    if (input.kind === "configuration") {
      const capabilities = await getProviderCapabilities(
        applicationId,
        connectionId,
      );
      const rows = capabilityRows(capabilities);
      return {
        kind: input.kind,
        status: "passed",
        checkedAt,
        provider: connection.provider,
        connectionId,
        environment,
        summary: `Runtime adapter resolved and encrypted credentials loaded. ${rows.filter((item) => item.supported).length} capabilities are enabled.`,
        capabilities: rows,
      };
    }

    const providerResourceId = input.providerResourceId?.trim();
    if (!providerResourceId) {
      throw new ConsoleProviderDiagnosticError(
        `Provider ${input.kind} ID is required for a read-only probe`,
        "invalid_input",
      );
    }

    if (input.kind === "payment") {
      const payment = await getProviderPayment(applicationId, connectionId, {
        providerPaymentId: providerResourceId,
      });
      return {
        kind: input.kind,
        status: "passed",
        checkedAt,
        provider: connection.provider,
        connectionId,
        environment,
        summary: `Read-only payment lookup succeeded with normalized status ${payment.status}.`,
        payment,
      };
    }

    if (input.kind === "subscription") {
      const subscription = await getProviderSubscription(
        applicationId,
        connectionId,
        { providerSubscriptionId: providerResourceId },
      );
      return {
        kind: input.kind,
        status: "passed",
        checkedAt,
        provider: connection.provider,
        connectionId,
        environment,
        summary: `Read-only subscription lookup succeeded with normalized status ${subscription.status}.`,
        subscription,
      };
    }

    throw new ConsoleProviderDiagnosticError(
      "Choose a supported provider diagnostic",
      "invalid_input",
    );
  } catch (error) {
    if (error instanceof ConsoleProviderDiagnosticError) throw error;
    throw new ConsoleProviderDiagnosticError(
      error instanceof Error
        ? error.message
        : "Provider diagnostic failed before a normalized result was returned",
      "provider_error",
    );
  }
}

export async function getConsoleProviderConnectionDetail(
  applicationId: string,
  connectionId: string,
  environment: ProviderMode,
) {
  const connection = await getProviderConnection(applicationId, connectionId);
  if (!connection || connection.mode !== environment) return null;

  const setup = getProviderSetup(connection.provider);
  let capabilities: ProviderCapabilities | null = null;
  let capabilityError: string | null = null;

  if (connection.status === "active") {
    try {
      capabilities = await getProviderCapabilities(
        applicationId,
        connection.id,
      );
    } catch (error) {
      capabilityError =
        error instanceof Error
          ? error.message
          : "Provider capabilities could not be resolved";
    }
  } else {
    capabilityError =
      "Capabilities are unavailable because this provider connection is revoked.";
  }

  return {
    connection,
    setup: setup
      ? {
          provider: setup.provider,
          label: setup.label,
          description: setup.description,
          credentialFields: setup.credentialFields.map((field) => ({
            key: field.key,
            label: field.label,
            help: field.help,
          })),
        }
      : null,
    capabilityRows: capabilities ? capabilityRows(capabilities) : [],
    capabilityError,
  };
}
