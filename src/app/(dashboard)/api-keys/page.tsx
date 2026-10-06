import Link from "next/link";
import { ApiKeyManager } from "@/components/developer/ApiKeyManager";
import { PageContainer } from "@/components/layout/PageContainer";
import { formatMessage, getDictionary } from "@/i18n/server";
import { getConsoleContext } from "@/server/control-plane/context";
import { listDeveloperApiKeys } from "@/server/control-plane/developer";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.apiKeys;
  const application = context.selectedApplication;

  return (
    <PageContainer
      title={t.title}
      description={
        application
          ? formatMessage(t.descriptionWithProject, {
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
        <ApiKeyManager keys={await listDeveloperApiKeys(application.id)} />
      )}
    </PageContainer>
  );
}
