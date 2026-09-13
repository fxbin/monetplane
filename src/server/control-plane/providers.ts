import type {
  ProviderCapabilities,
  ProviderCapability,
  ProviderMode,
} from "@/modules/providers/contract";
import { getProviderCapabilities } from "@/modules/providers/runtime";
import { getProviderConnection } from "@/modules/providers/service";
import { getProviderSetup } from "@/modules/providers/setup";

export type ConsoleProviderCapability = {
  key: ProviderCapability;
  supported: boolean;
};

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

  const capabilityRows: ConsoleProviderCapability[] = capabilities
    ? (
        Object.entries(capabilities) as Array<[ProviderCapability, boolean]>
      ).map(([key, supported]) => ({ key, supported }))
    : [];

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
    capabilityRows,
    capabilityError,
  };
}
