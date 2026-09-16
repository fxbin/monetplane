import Link from "next/link";
import { ApiKeyManager } from "@/components/developer/ApiKeyManager";
import { PageContainer } from "@/components/layout/PageContainer";
import { getConsoleContext } from "@/server/control-plane/context";
import { listDeveloperApiKeys } from "@/server/control-plane/developer";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const context = await getConsoleContext();
  const application = context.selectedApplication;

  return (
    <PageContainer
      title="API Keys"
      description={
        application
          ? `Manage server credentials for ${application.name}.`
          : "Create a project before issuing server credentials."
      }
    >
      {!application ? (
        <div className="empty-state">
          <h2 className="empty-state-title">No project selected</h2>
          <p className="empty-state-desc">
            API keys authenticate the MonetPlane server SDK. Create a project first.
          </p>
          <div className="empty-state-actions">
            <Link className="btn btn-primary" href="/applications/new">
              Create project
            </Link>
          </div>
        </div>
      ) : (
        <ApiKeyManager keys={await listDeveloperApiKeys(application.id)} />
      )}
    </PageContainer>
  );
}
