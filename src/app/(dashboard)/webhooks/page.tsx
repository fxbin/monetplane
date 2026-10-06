import Link from "next/link";
import { WebhookManager } from "@/components/developer/WebhookManager";
import { PageContainer } from "@/components/layout/PageContainer";
import { formatMessage, getDictionary } from "@/i18n/server";
import { getConsoleContext } from "@/server/control-plane/context";
import { getWebhookConsoleData } from "@/server/control-plane/webhooks";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.webhooks;
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;
  const webhookData = application
    ? await getWebhookConsoleData(application.id, context)
    : null;

  return (
    <PageContainer
      title={t.title}
      description={
        application
          ? formatMessage(t.descriptionWithProject, {
              environment: environmentLabel,
              application: application.name,
            })
          : t.descriptionNoProject
      }
    >
      {!application ? (
        <div className="empty-state">
          <h2 className="empty-state-title">
            {dictionary.common.noProjectTitle}
          </h2>
          <p className="empty-state-desc">{t.emptyDesc}</p>
          <div className="empty-state-actions">
            <Link className="btn btn-primary" href="/applications/new">
              {t.createProject}
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="context-notice">
            <span className="context-notice-label">{t.noticeLabel}</span>
            <strong>{environmentLabel}</strong>
            <span>{t.noticeBody}</span>
          </div>
          <WebhookManager
            environmentLabel={environmentLabel}
            endpoints={webhookData?.endpoints ?? []}
            deliveries={webhookData?.deliveries ?? []}
          />
        </>
      )}
    </PageContainer>
  );
}
