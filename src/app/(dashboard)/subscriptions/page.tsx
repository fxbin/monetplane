import Link from "next/link";
import { BillingOperationsFilters } from "@/components/billing/BillingOperationsFilters";
import { PageContainer } from "@/components/layout/PageContainer";
import { formatAmount, formatDateTime } from "@/lib/format";
import {
  type BillingOperationsFilter,
  getProviderFilterOptions,
  getSubscriptionsList,
} from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type SubscriptionsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function readFilter(
  params: Record<string, string | string[] | undefined>,
): BillingOperationsFilter {
  const read = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : undefined;
  };
  return {
    status: read("status"),
    customer: read("customer"),
    product: read("product"),
    providerConnectionId: read("providerConnectionId"),
    from: read("from"),
    to: read("to"),
  };
}

export default async function SubscriptionsPage({
  searchParams,
}: SubscriptionsPageProps) {
  const [context, params] = await Promise.all([
    getConsoleContext(),
    searchParams,
  ]);
  const filter = readFilter(params);
  const applicationId = context.selectedApplication?.id;
  const [rows, providers] = applicationId
    ? await Promise.all([
        getSubscriptionsList(applicationId, filter),
        getProviderFilterOptions(applicationId),
      ])
    : [[], []];

  return (
    <PageContainer
      title="Subscriptions"
      description="Inspect recurring billing lifecycle, customer access, provider state, and cancellation recovery."
    >
      {applicationId && (
        <BillingOperationsFilters
          action="/subscriptions"
          filter={filter}
          providers={providers}
          statuses={[
            { value: "pending", label: "Pending" },
            { value: "active", label: "Active" },
            { value: "past_due", label: "Past due" },
            { value: "cancelled", label: "Cancelled" },
            { value: "expired", label: "Expired" },
          ]}
        />
      )}

      {rows.length > 0 ? (
        <div className="card billing-table-card">
          <div className="table-wrapper">
            <table className="data-table billing-operations-table">
              <thead>
                <tr>
                  <th>Subscription</th>
                  <th>Customer</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Period end</th>
                  <th>Provider</th>
                  <th>Updated</th>
                  <th aria-label="Open subscription" />
                </tr>
              </thead>
              <tbody>
                {rows.map((subscription) => {
                  const latestOperation = subscription.operations[0];
                  return (
                    <tr key={subscription.id}>
                      <td>
                        <div className="billing-id-cell">
                          <code>{subscription.id}</code>
                          <span>{subscription.providerSubscriptionId}</span>
                          {latestOperation?.status === "needs_reconciliation" && (
                            <span className="badge badge-warning">Needs reconciliation</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <Link href={`/customers/${subscription.applicationCustomerId}`}>
                          {subscription.externalCustomerId ?? "Customer"}
                        </Link>
                        {subscription.customerEmail && (
                          <div className="cell-muted">{subscription.customerEmail}</div>
                        )}
                      </td>
                      <td>
                        {subscription.items.length > 0 ? (
                          <div className="billing-plan-cell">
                            <strong>
                              {subscription.items
                                .map(
                                  (item) =>
                                    item.productName ?? item.productKey ?? item.productId,
                                )
                                .join(", ")}
                            </strong>
                            {subscription.items[0]?.amountMinor !== null &&
                              subscription.items[0]?.amountMinor !== undefined &&
                              subscription.items[0]?.currency && (
                                <span>
                                  {formatAmount(
                                    subscription.items[0].amountMinor,
                                    subscription.items[0].currency,
                                  )}
                                  /{subscription.items[0].recurringInterval ?? "period"}
                                </span>
                              )}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <span className={`badge badge-${subscription.status}`}>
                          {subscription.status.replace("_", " ")}
                        </span>
                      </td>
                      <td className="cell-muted">
                        {subscription.currentPeriodEnd
                          ? formatDateTime(subscription.currentPeriodEnd)
                          : "—"}
                      </td>
                      <td>{subscription.providerName ?? subscription.provider ?? "—"}</td>
                      <td className="cell-muted">
                        {formatDateTime(subscription.updatedAt)}
                      </td>
                      <td>
                        <Link
                          className="table-row-link"
                          href={`/subscriptions/${subscription.id}`}
                        >
                          Open
                        </Link>
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
          <h2 className="empty-state-title">
            {applicationId
              ? "No subscriptions match this view"
              : "No project selected"}
          </h2>
          <p className="empty-state-desc">
            {applicationId
              ? "Adjust the filters or wait for recurring checkout activity."
              : "Select or create a project before inspecting subscriptions."}
          </p>
        </div>
      )}
    </PageContainer>
  );
}
