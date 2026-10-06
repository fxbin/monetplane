import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary } from "@/i18n/server";
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
  const [context, params, dictionary] = await Promise.all([
    getConsoleContext(),
    searchParams,
    getDictionary(),
  ]);
  const t = dictionary.customers;
  const projectName = context.selectedApplication?.name;
  const search = params.q?.trim() ?? "";
  const filter = normalizeFilter(params.filter);
  const customers = context.selectedApplication
    ? await getCustomerWorkspaceList(
        context.selectedApplication.id,
        {
          search,
          filter,
        },
        context.environment,
      )
    : [];

  return (
    <PageContainer
      title={t.title}
      description={
        projectName
          ? formatMessage(t.descriptionWithProject, {
              application: projectName,
            })
          : t.descriptionNoProject
      }
    >
      {context.selectedApplication && (
        <form className="customer-toolbar card" method="get">
          <label className="customer-search-field">
            <span className="sr-only">{t.searchAria}</span>
            <input
              className="form-input"
              defaultValue={search}
              name="q"
              placeholder={t.searchPlaceholder}
              autoComplete="off"
            />
          </label>
          <label className="customer-filter-field">
            <span className="sr-only">{t.filterAria}</span>
            <select className="form-input" defaultValue={filter} name="filter">
              <option value="all">{t.allCustomers}</option>
              <option value="subscribed">{t.activeSubscriptions}</option>
              <option value="credits">{t.availableCredits}</option>
            </select>
          </label>
          <button className="btn btn-secondary" type="submit">
            {t.apply}
          </button>
          {(search || filter !== "all") && (
            <Link className="customer-clear-link" href="/customers">
              {t.clear}
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
                  <th>{t.thCustomer}</th>
                  <th>{t.thSubscription}</th>
                  <th>{t.thCredits}</th>
                  <th>{t.thCreated}</th>
                  <th aria-label={t.ariaOpen} />
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <div className="customer-identity-cell">
                        <strong>{customer.externalCustomerId}</strong>
                        <span>{customer.email ?? t.noEmail}</span>
                      </div>
                    </td>
                    <td>
                      {customer.subscriptions.active > 0 ? (
                        <StatusBadge
                          status="active"
                          label={formatMessage(t.activeCount, {
                            count: String(customer.subscriptions.active),
                          })}
                        />
                      ) : customer.subscriptions.attention > 0 ? (
                        <StatusBadge status="past_due" />
                      ) : (
                        <span className="cell-muted">{t.none}</span>
                      )}
                    </td>
                    <td>
                      <div className="customer-credit-cell">
                        <strong>
                          {customer.credits.available.toLocaleString()}
                        </strong>
                        {customer.credits.reserved > 0 && (
                          <span>
                            {formatMessage(t.creditsSummary, {
                              count: customer.credits.reserved.toLocaleString(),
                            })}
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
                        {t.open}
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
              ? dictionary.common.noProjectTitle
              : search || filter !== "all"
                ? t.emptyTitle
                : t.noProjectEmptyTitle}
          </h2>
          <p className="empty-state-desc">
            {!context.selectedApplication
              ? t.noProjectEmptyDescription
              : search || filter !== "all"
                ? t.emptyFilteredDescription
                : t.emptySdkDescription}
          </p>
          {!context.selectedApplication && (
            <div className="empty-state-actions">
              <a className="btn btn-primary" href="/applications/new">
                {t.createProject}
              </a>
            </div>
          )}
        </div>
      )}
    </PageContainer>
  );
}
