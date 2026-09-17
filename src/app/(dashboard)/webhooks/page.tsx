import Link from "next/link";
import { WebhookManager } from "@/components/developer/WebhookManager";
import { PageContainer } from "@/components/layout/PageContainer";
import {
  listWebhookDeliveries,
  listWebhookEndpoints,
} from "@/modules/webhooks";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const context = await getConsoleContext();
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test" ? "Sandbox" : "Production";

  return (
    <PageContainer
      title="Webhooks"
      description={
        application
          ? `Configure ${environmentLabel} event delivery for ${application.name}.`
          : "Create a project before configuring developer webhooks."
      }
    >
      {!application ? (
        <div className="empty-state">
          <h2 className="empty-state-title">No project selected</h2>
          <p className="empty-state-desc">
            Developer webhook endpoints are configured per provider environment.
          </p>
          <div className="empty-state-actions">
            <Link className="btn btn-primary" href="/applications/new">
              Create project
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="context-notice">
            <span className="context-notice-label">
              Current webhook environment
            </span>
            <strong>{environmentLabel}</strong>
            <span>
              Endpoints and delivery history on this page are
              environment-scoped. API keys are shared across environments in
              this release.
            </span>
          </div>
          <WebhookManager
            environmentLabel={environmentLabel}
            endpoints={
              await listWebhookEndpoints(application.id, context.environment)
            }
            deliveries={
              await listWebhookDeliveries(application.id, context.environment, {
                limit: 50,
              })
            }
          />
        </>
      )}
    </PageContainer>
  );
}
