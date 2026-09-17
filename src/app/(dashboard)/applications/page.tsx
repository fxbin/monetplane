import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { getApplicationList } from "@/server/control-plane/console-queries";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  const [applications, context] = await Promise.all([
    getApplicationList(),
    getConsoleContext(),
  ]);

  return (
    <PageContainer
      title="Projects"
      description="Each project isolates one product or website's MonetPlane billing state."
      primaryAction={{ label: "Create project", href: "/applications/new" }}
    >
      {applications.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Slug</th>
                  <th>Status</th>
                  <th>Created</th>
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
          <h2 className="empty-state-title">Create your first project</h2>
          <p className="empty-state-desc">
            Projects are the isolation boundary for catalog, customers, billing
            providers, entitlements, and credits.
          </p>
          <div className="empty-state-actions">
            <a className="btn btn-primary" href="/applications/new">
              Create project
            </a>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
