import { PageContainer } from "@/components/layout/PageContainer";
import { getProviderList } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const context = await getConsoleContext();
  const providers = await getProviderList(
    context.selectedApplication?.id,
    context.environment,
  );
  const projectName = context.selectedApplication?.name;
  const environmentLabel = context.environment === "test" ? "Sandbox" : "Production";

  return (
    <PageContainer
      title="Payment Providers"
      description={
        projectName
          ? `Manage ${environmentLabel} payment providers for ${projectName}.`
          : "Create a project before connecting a payment provider."
      }
      primaryAction={
        context.selectedApplication
          ? { label: "Connect provider", href: "/providers/new" }
          : { label: "Create project", href: "/applications/new" }
      }
    >
      <div className="context-notice">
        <span className="context-notice-label">Current provider environment</span>
        <strong>{environmentLabel}</strong>
        <span>
          Catalog, customer, and credit state remain project-scoped in P1; this
          environment context currently selects provider configuration and test/live
          checkout behavior.
        </span>
      </div>

      {providers.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Name</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((conn) => (
                  <tr key={conn.id}>
                    <td className="cell-mono">{conn.provider}</td>
                    <td>{conn.name}</td>
                    <td>
                      <span className={`badge badge-${conn.mode}`}>
                        {conn.mode}
                      </span>
                    </td>
                    <td>
                      <span className={`badge badge-${conn.status}`}>
                        {conn.status}
                      </span>
                    </td>
                    <td className="cell-muted">
                      {new Date(conn.createdAt).toLocaleDateString()}
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
              ? `No ${environmentLabel} provider connected`
              : "No project selected"}
          </h2>
          <p className="empty-state-desc">
            {context.selectedApplication
              ? `Connect a provider for ${projectName} in ${environmentLabel}. MonetPlane keeps provider-specific behavior behind one shared billing contract.`
              : "Create a project first, then connect its Sandbox provider before moving to Production."}
          </p>
          <div className="empty-state-actions">
            <a
              className="btn btn-primary"
              href={context.selectedApplication ? "/providers/new" : "/applications/new"}
            >
              {context.selectedApplication ? "Connect provider" : "Create project"}
            </a>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
