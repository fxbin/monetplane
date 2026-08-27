import { PageContainer } from "@/components/layout/PageContainer";
import { getProviderList } from "@/modules/admin/queries";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const providers = await getProviderList();

  return (
    <PageContainer
      title="Payment Providers"
      description="Connect and monitor your payment provider integrations."
      primaryAction={{ label: "Connect provider", href: "/providers/new" }}
    >
      {providers.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Name</th>
                  <th>Application</th>
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
                    <td className="cell-muted">
                      {conn.applicationName ?? "—"}
                    </td>
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
          <h2 className="empty-state-title">No providers connected</h2>
          <p className="empty-state-desc">
            Connect a payment provider to start accepting payments. MonetPlane
            supports Creem, Waffo, and custom providers through a shared
            contract.
          </p>
          <div className="empty-state-actions">
            <a className="btn btn-primary" href="/providers/new">
              Connect provider
            </a>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
