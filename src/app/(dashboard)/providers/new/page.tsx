import { redirect } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProviderConnectForm } from "@/components/providers/ProviderConnectForm";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function NewProviderPage() {
  const context = await getConsoleContext();
  if (!context.selectedApplication) redirect("/applications/new");

  const environmentLabel =
    context.environment === "test" ? "Sandbox" : "Production";

  return (
    <PageContainer
      title="Connect payment provider"
      description={`Add a ${environmentLabel} payment connection to ${context.selectedApplication.name}.`}
      primaryAction={{ label: "Back to providers", href: "/providers" }}
    >
      <div className="context-notice provider-connect-context">
        <span className="context-notice-label">Connection scope</span>
        <strong>{context.selectedApplication.name}</strong>
        <span>·</span>
        <strong>{environmentLabel}</strong>
        <span>
          Provider mode is locked to the current console environment so secrets
          cannot accidentally cross Sandbox and Production.
        </span>
      </div>

      <ProviderConnectForm
        projectName={context.selectedApplication.name}
        environment={context.environment}
      />
    </PageContainer>
  );
}
