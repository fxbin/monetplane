import Link from "next/link";
import { BillingOperationsFilters } from "@/components/billing/BillingOperationsFilters";
import { PageContainer } from "@/components/layout/PageContainer";
import { EmptyState, StatusBadge } from "@/components/ui/console";
import { getDictionary } from "@/i18n/server";
import { formatAmount, formatDateTime } from "@/lib/format";
import {
  type BillingOperationsFilter,
  getPaymentsList,
  getProviderFilterOptions,
} from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type PaymentsPageProps = {
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

export default async function PaymentsPage({
  searchParams,
}: PaymentsPageProps) {
  const [context, params, dictionary] = await Promise.all([
    getConsoleContext(),
    searchParams,
    getDictionary(),
  ]);
  const t = dictionary.payments;
  const filter = readFilter(params);
  const applicationId = context.selectedApplication?.id;
  const [rows, providers] = applicationId
    ? await Promise.all([
        getPaymentsList(applicationId, {
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
          action="/payments"
          filter={filter}
          providers={providers}
          statuses={[
            { value: "pending", label: t.statusPending },
            { value: "succeeded", label: t.statusSucceeded },
            { value: "failed", label: t.statusFailed },
            { value: "refunded", label: t.statusRefunded },
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
                  <th>{t.thPayment}</th>
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
                {rows.map((payment) => {
                  const latestOperation = payment.operations[0];
                  return (
                    <tr key={payment.id}>
                      <td>
                        <div className="billing-id-cell">
                          <code>{payment.id}</code>
                          <span>{payment.providerPaymentId}</span>
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
                        {payment.applicationCustomerId ? (
                          <Link
                            href={`/customers/${payment.applicationCustomerId}`}
                          >
                            {payment.externalCustomerId ?? t.customerFallback}
                          </Link>
                        ) : (
                          <span className="cell-muted">{t.unknown}</span>
                        )}
                        {payment.customerEmail && (
                          <div className="cell-muted">
                            {payment.customerEmail}
                          </div>
                        )}
                      </td>
                      <td>
                        {payment.items.length > 0
                          ? payment.items
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
                        {formatAmount(payment.amountMinor, payment.currency)}
                      </td>
                      <td>
                        <StatusBadge status={payment.status} />
                      </td>
                      <td>{payment.providerName ?? payment.provider ?? "—"}</td>
                      <td className="cell-muted">
                        {formatDateTime(payment.createdAt)}
                      </td>
                      <td>
                        <Link
                          className="table-row-link"
                          href={`/payments/${payment.id}`}
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
