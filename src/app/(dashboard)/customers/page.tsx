import { PageContainer } from "@/components/layout/PageContainer";
import { getCustomerList } from "@/modules/admin/queries";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const customers = await getCustomerList(100);

  return (
    <PageContainer
      title="Customers"
      description="Inspect customer billing state, credit balances, and payment history."
    >
      {customers.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>External ID</th>
                  <th>Email</th>
                  <th>Application</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td className="cell-mono">{customer.externalCustomerId}</td>
                    <td>{customer.email ?? "—"}</td>
                    <td className="cell-muted">
                      {customer.applicationName ?? "—"}
                    </td>
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
          <h2 className="empty-state-title">No customers yet</h2>
          <p className="empty-state-desc">
            Customers appear here once they complete a checkout or are created
            through the SDK.
          </p>
        </div>
      )}
    </PageContainer>
  );
}
