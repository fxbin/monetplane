import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary } from "@/i18n/server";
import { getProviderList } from "@/server/control-plane/console-queries";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.providers;
  const providers = await getProviderList(
    context.selectedApplication?.id,
    context.environment,
  );
  const projectName = context.selectedApplication?.name;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  return (
    <PageContainer
      title={t.title}
      description={
        projectName
          ? formatMessage(t.descriptionWithProject, {
              environment: environmentLabel,
              application: projectName,
            })
          : t.descriptionNoProject
      }
      primaryAction={
        context.selectedApplication
          ? { label: t.connectProvider, href: "/providers/new" }
          : { label: t.createProject, href: "/applications/new" }
      }
    >
      <div className="context-notice">
        <span className="context-notice-label">{t.noticeLabel}</span>
        <strong>{environmentLabel}</strong>
        <span>{t.noticeBody}</span>
      </div>

      {providers.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thProvider}</th>
                  <th>{t.thName}</th>
                  <th>{t.thMode}</th>
                  <th>{t.thStatus}</th>
                  <th>{t.thCreated}</th>
                  <th aria-label={t.thActions} />
                </tr>
              </thead>
              <tbody>
                {providers.map((conn) => (
                  <tr key={conn.id}>
                    <td className="cell-mono">{conn.provider}</td>
                    <td>
                      <Link
                        className="provider-connection-link"
                        href={`/providers/${conn.id}`}
                      >
                        {conn.name}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={conn.mode} />
                    </td>
                    <td>
                      <StatusBadge status={conn.status} />
                    </td>
                    <td className="cell-muted">
                      {new Date(conn.createdAt).toLocaleDateString()}
                    </td>
                    <td className="provider-table-action">
                      <Link
                        className="btn btn-secondary"
                        href={`/providers/${conn.id}`}
                      >
                        {t.manage}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <h2 className="empty-state-title">
            {context.selectedApplication
              ? formatMessage(t.emptyTitle, { environment: environmentLabel })
              : dictionary.common.noProjectTitle}
          </h2>
          <p className="empty-state-desc">
            {context.selectedApplication
              ? formatMessage(t.emptyDesc, {
                  application: projectName ?? "",
                  environment: environmentLabel,
                })
              : t.emptyNoProjectDesc}
          </p>
          <div className="empty-state-actions">
            <a
              className="btn btn-primary"
              href={
                context.selectedApplication
                  ? "/providers/new"
                  : "/applications/new"
              }
            >
              {context.selectedApplication
                ? t.connectProvider
                : t.createProject}
            </a>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
