import Link from "next/link";
import { BillingOperationsFilters } from "@/components/billing/BillingOperationsFilters";
import { PageContainer } from "@/components/layout/PageContainer";
import { EmptyState, StatusBadge } from "@/components/ui/console";
import { getDictionary, getLocaleTag } from "@/i18n/server";
import { formatAmount, formatDateTime } from "@/lib/format";
import {
  type BillingOperationsFilter,
  getProviderFilterOptions,
  getRefundsList,
} from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type RefundsPageProps = {
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

export default async function RefundsPage({ searchParams }: RefundsPageProps) {
  const [context, params, dictionary] = await Promise.all([
    getConsoleContext(),
    searchParams,
    getDictionary(),
  ]);
  const localeTag = await getLocaleTag();
  const fmtDateTime = (d: Date | string) => formatDateTime(d, localeTag);
  const t = dictionary.refunds;
  const filter = readFilter(params);
  const applicationId = context.selectedApplication?.id;
  const [rows, providers] = applicationId
    ? await Promise.all([
        getRefundsList(applicationId, {
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
          action="/refunds"
          filter={filter}
          providers={providers}
          statuses={[
            { value: "pending", label: t.statusPending },
            { value: "succeeded", label: t.statusSucceeded },
            { value: "failed", label: t.statusFailed },
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
                  <th>{t.thRefund}</th>
                  <th>{t.thCustomer}</th>
                  <th>{t.thProduct}</th>
                  <th>{t.thAmount}</th>
                  <th>{t.thStatus}</th>
                  <th>{t.thProvider}</th>
                  <th>{t.thCreated}</th>
                  <th aria-label={t.ariaOpen} />
                </tr>
              </thead>
              <tbody>
                {rows.map((refund) => (
                  <tr key={refund.id}>
                    <td>
                      <div className="billing-id-cell">
                        <code>{refund.id}</code>
                        <span>{refund.providerRefundId}</span>
                      </div>
                    </td>
                    <td>
                      {refund.applicationCustomerId ? (
                        <Link
                          href={`/customers/${refund.applicationCustomerId}`}
                        >
                          {refund.externalCustomerId ?? t.customerFallback}
                        </Link>
                      ) : (
                        <span className="cell-muted">{t.customerFallback}</span>
                      )}
                      {refund.customerEmail && (
                        <div className="cell-muted">{refund.customerEmail}</div>
                      )}
                    </td>
                    <td>
                      {refund.items.length > 0
                        ? refund.items
                            .map(
                              (item) =>
                                item.productName ??
                                item.productKey ??
                                item.productId,
                            )
                            .join(", ")
                        : "—"}
                    </td>
                    <td>
                      {refund.amountMinor !== null && refund.paymentCurrency
                        ? formatAmount(
                            refund.amountMinor,
                            refund.paymentCurrency,
                          )
                        : "—"}
                    </td>
                    <td>
                      <StatusBadge status={refund.status} />
                    </td>
                    <td>{refund.providerName ?? refund.provider ?? "—"}</td>
                    <td className="cell-muted">
                      {fmtDateTime(refund.createdAt)}
                    </td>
                    <td>
                      <Link
                        className="table-row-link"
                        href={`/refunds/${refund.id}`}
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
