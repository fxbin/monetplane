import Link from "next/link";
import { BillingOperationsFilters } from "@/components/billing/BillingOperationsFilters";
import { PageContainer } from "@/components/layout/PageContainer";
import { EmptyState, StatusBadge } from "@/components/ui/console";
import { getDictionary, getLocaleTag } from "@/i18n/server";
import { formatAmount, formatDate, formatDateTime } from "@/lib/format";
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
  const [context, params, dictionary] = await Promise.all([
    getConsoleContext(),
    searchParams,
    getDictionary(),
  ]);
  const localeTag = await getLocaleTag();
  const fmtDate = (d: Date | string) => formatDate(d, localeTag);
  const fmtDateTime = (d: Date | string) => formatDateTime(d, localeTag);
  const t = dictionary.subscriptions;
  const filter = readFilter(params);
  const applicationId = context.selectedApplication?.id;
  const [rows, providers] = applicationId
    ? await Promise.all([
        getSubscriptionsList(applicationId, {
          ...filter,
          providerMode: context.environment,
        }),
        getProviderFilterOptions(applicationId, context.environment),
      ])
    : [[], []];

  return (
    <PageContainer title={t.title} description={t.description}>
      {applicationId && (
        <BillingOperationsFilters
          action="/subscriptions"
          filter={filter}
          providers={providers}
          statuses={[
            { value: "pending", label: t.statusPending },
            { value: "active", label: t.statusActive },
            { value: "past_due", label: t.statusPastDue },
            { value: "cancelled", label: t.statusCancelled },
            { value: "expired", label: t.statusExpired },
          ]}
          labels={dictionary.billingFilters}
        />
      )}

      {rows.length > 0 ? (
        <div className="card billing-table-card">
          <div className="table-wrapper">
            <table className="data-table billing-operations-table">
              <thead>
                <tr>
                  <th>{t.thSubscription}</th>
                  <th>{t.thCustomer}</th>
                  <th>{t.thPlan}</th>
                  <th>{t.thStatus}</th>
                  <th>{t.thPeriodEnd}</th>
                  <th>{t.thProvider}</th>
                  <th>{t.thUpdated}</th>
                  <th aria-label={t.ariaOpen} />
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
                          {latestOperation?.status ===
                            "needs_reconciliation" && (
                            <StatusBadge
                              status="warning"
                              label={t.needsReconciliation}
                            />
                          )}
                        </div>
                      </td>
                      <td>
                        <Link
                          href={`/customers/${subscription.applicationCustomerId}`}
                        >
                          {subscription.externalCustomerId ??
                            t.customerFallback}
                        </Link>
                        {subscription.customerEmail && (
                          <div className="cell-muted">
                            {subscription.customerEmail}
                          </div>
                        )}
                      </td>
                      <td>
                        {subscription.items.length > 0 ? (
                          <div className="billing-plan-cell">
                            <strong>
                              {subscription.items
                                .map(
                                  (item) =>
                                    item.productName ??
                                    item.productKey ??
                                    item.productId,
                                )
                                .join(", ")}
                            </strong>
                            {subscription.items[0]?.amountMinor !== null &&
                              subscription.items[0]?.amountMinor !==
                                undefined &&
                              subscription.items[0]?.currency && (
                                <span>
                                  {formatAmount(
                                    subscription.items[0].amountMinor,
                                    subscription.items[0].currency,
                                  )}
                                  /
                                  {subscription.items[0].recurringInterval ??
                                    "period"}
                                </span>
                              )}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <StatusBadge
                          status={subscription.status}
                          label={subscription.status.replace("_", " ")}
                        />
                      </td>
                      <td className="cell-muted">
                        {subscription.currentPeriodEnd
                          ? fmtDateTime(subscription.currentPeriodEnd)
                          : "—"}
                      </td>
                      <td>
                        {subscription.providerName ??
                          subscription.provider ??
                          "—"}
                      </td>
                      <td className="cell-muted">
                        {fmtDateTime(subscription.updatedAt)}
                      </td>
                      <td>
                        <Link
                          className="table-row-link"
                          href={`/subscriptions/${subscription.id}`}
                        >
                          {t.open}
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
        <EmptyState
          title={
            applicationId ? t.emptyTitle : dictionary.common.noProjectTitle
          }
          description={
            applicationId ? t.emptyDescription : t.noProjectDescription
          }
        />
      )}
    </PageContainer>
  );
}
