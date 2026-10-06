import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { getDictionary } from "@/i18n/server";
import { getApplicationList } from "@/server/control-plane/console-queries";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  const [applications, context, dictionary] = await Promise.all([
    getApplicationList(),
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.applications;

  return (
    <PageContainer
      title={t.title}
      description={t.description}
      primaryAction={{ label: t.createProject, href: "/applications/new" }}
    >
      {applications.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thProject}</th>
                  <th>{t.thSlug}</th>
                  <th>{t.thStatus}</th>
                  <th>{t.thCreated}</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((application) => {
                  const selected =
                    context.selectedApplication?.id === application.id;
                  return (
                    <tr key={application.id}>
                      <td>
                        <Link
                          className="table-primary-link"
                          href={`/applications/${application.id}`}
                        >
                          {application.name}
                        </Link>
                        {selected && <StatusBadge status="current" />}
                      </td>
                      <td className="cell-mono">{application.slug}</td>
                      <td>
                        <StatusBadge status={application.status} />
                      </td>
                      <td className="cell-muted">
                        {new Date(application.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <h2 className="empty-state-title">{t.emptyTitle}</h2>
          <p className="empty-state-desc">{t.emptyDesc}</p>
          <div className="empty-state-actions">
            <a className="btn btn-primary" href="/applications/new">
              {t.createProject}
            </a>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
