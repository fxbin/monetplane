import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { getConsoleContext } from "@/server/control-plane/context";
import {
  type CustomerListFilter,
  getCustomerWorkspaceList,
} from "@/server/control-plane/customer-workspace";

export const dynamic = "force-dynamic";

type CustomersPageProps = {
  searchParams: Promise<{ q?: string; filter?: string }>;
};

function normalizeFilter(value: string | undefined): CustomerListFilter {
  return value === "subscribed" || value === "credits" ? value : "all";
}

export default async function CustomersPage({
  searchParams,
}: CustomersPageProps) {
  const [context, params] = await Promise.all([
    getConsoleContext(),
    searchParams,
  ]);
  const projectName = context.selectedApplication?.name;
  const search = params.q?.trim() ?? "";
  const filter = normalizeFilter(params.filter);
  const customers = context.selectedApplication
    ? await getCustomerWorkspaceList(context.selectedApplication.id, {
        search,
        filter,
      })
    : [];

  return (
    <PageContainer
      title="Customers"
      description={
        projectName
          ? `Understand and operate ${projectName} customer billing state from one workspace.`
          : "Create a project before customer billing data can appear."
      }
    >
      {context.selectedApplication && (
        <form className="customer-toolbar card" method="get">
          <label className="customer-search-field">
            <span className="sr-only">Search customers</span>
            <input
              defaultValue={search}
              name="q"
              placeholder="Search external ID or email"
            />
          </label>
          <label className="customer-filter-field">
            <span className="sr-only">Filter customers</span>
            <select defaultValue={filter} name="filter">
              <option value="all">All customers</option>
              <option value="subscribed">Active subscriptions</option>
              <option value="credits">Available credits</option>
            </select>
          </label>
          <button className="btn btn-secondary" type="submit">
            Apply
          </button>
          {(search || filter !== "all") && (
            <Link className="customer-clear-link" href="/customers">
              Clear
            </Link>
          )}
        </form>
      )}

      {customers.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table customer-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Subscription</th>
                  <th>Credits</th>
                  <th>Created</th>
                  <th aria-label="Open customer" />
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <div className="customer-identity-cell">
                        <strong>{customer.externalCustomerId}</strong>
                        <span>{customer.email ?? "No email"}</span>
                      </div>
                    </td>
                    <td>
                      {customer.subscriptions.active > 0 ? (
                        <span className="badge badge-active">
                          {customer.subscriptions.active} active
                        </span>
                      ) : customer.subscriptions.attention > 0 ? (
                        <span className="badge badge-past_due">Past due</span>
                      ) : (
                        <span className="cell-muted">None</span>
                      )}
                    </td>
                    <td>
                      <div className="customer-credit-cell">
                        <strong>
                          {customer.credits.available.toLocaleString()}
                        </strong>
                        {customer.credits.reserved > 0 && (
                          <span>
                            {customer.credits.reserved.toLocaleString()} reserved
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="cell-muted">
                      {new Date(customer.createdAt).toLocaleDateString()}
                    </td>
                    <td>
                      <Link
                        className="table-row-link"
                        href={`/customers/${customer.id}`}
                      >
                        Open
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
            {!context.selectedApplication
              ? "No project selected"
              : search || filter !== "all"
                ? "No customers match this view"
                : "No customers yet"}
          </h2>
          <p className="empty-state-desc">
            {!context.selectedApplication
              ? "Create a project to establish an isolated customer namespace."
              : search || filter !== "all"
                ? "Adjust the search or filter to see more customer billing records."
                : "Customers appear here once they complete a checkout or are created through the server SDK."}
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
