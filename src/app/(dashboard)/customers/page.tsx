import { PageContainer } from "@/components/layout/PageContainer";
import { getCustomerList } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const context = await getConsoleContext();
  const customers = await getCustomerList(100, context.selectedApplication?.id);
  const projectName = context.selectedApplication?.name;

  return (
    <PageContainer
      title="Customers"
      description={
        projectName
          ? `Inspect ${projectName} customer billing state, credits, and history.`
          : "Create a project before customer billing data can appear."
      }
    >
      {customers.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>External ID</th>
                  <th>Email</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td className="cell-mono">{customer.externalCustomerId}</td>
                    <td>{customer.email ?? "—"}</td>
                    <td className="cell-muted">
                      {new Date(customer.createdAt).toLocaleDateString()}
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
            {context.selectedApplication ? "No customers yet" : "No project selected"}
          </h2>
          <p className="empty-state-desc">
            {context.selectedApplication
              ? "Customers appear here once they complete a checkout or are created through the server SDK."
              : "Create a project to establish an isolated customer namespace."}
          </p>
          {!context.selectedApplication && (
            <div className="empty-state-actions">
              <a className="btn btn-primary" href="/applications/new">
                Create project
              </a>
            </div>
          )}
        </div>
      )}
    </PageContainer>
  );
}
