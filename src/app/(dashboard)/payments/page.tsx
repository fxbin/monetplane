import Link from "next/link";
import { BillingOperationsFilters } from "@/components/billing/BillingOperationsFilters";
import { PageContainer } from "@/components/layout/PageContainer";
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

export default async function PaymentsPage({ searchParams }: PaymentsPageProps) {
  const [context, params] = await Promise.all([
    getConsoleContext(),
    searchParams,
  ]);
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
    <PageContainer
      title="Payments"
      description="Find payments quickly, understand provider-neutral state, and surface refund or reconciliation work."
    >
      {applicationId && (
        <BillingOperationsFilters
          action="/payments"
          filter={filter}
          providers={providers}
          statuses={[
            { value: "pending", label: "Pending" },
            { value: "succeeded", label: "Succeeded" },
            { value: "failed", label: "Failed" },
            { value: "refunded", label: "Refunded" },
          ]}
        />
      )}

      {rows.length > 0 ? (
        <div className="card billing-table-card">
          <div className="table-wrapper">
            <table className="data-table billing-operations-table">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th>Customer</th>
                  <th>Product</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Created</th>
                  <th aria-label="Open payment" />
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
                          {latestOperation?.status === "needs_reconciliation" && (
                            <span className="badge badge-warning">
                              Needs reconciliation
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        {payment.applicationCustomerId ? (
                          <Link href={`/customers/${payment.applicationCustomerId}`}>
                            {payment.externalCustomerId ?? "Customer"}
                          </Link>
                        ) : (
                          <span className="cell-muted">Unknown</span>
                        )}
                        {payment.customerEmail && (
                          <div className="cell-muted">{payment.customerEmail}</div>
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
                        <span className={`badge badge-${payment.status}`}>
                          {payment.status}
                        </span>
                      </td>
                      <td>
                        {payment.providerName ?? payment.provider ?? "—"}
                      </td>
                      <td className="cell-muted">
                        {formatDateTime(payment.createdAt)}
                      </td>
                      <td>
                        <Link
                          className="table-row-link"
                          href={`/payments/${payment.id}`}
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
              ? "No payments match this view"
              : "No project selected"}
          </h2>
          <p className="empty-state-desc">
            {applicationId
              ? "Adjust the filters or wait for checkout activity to arrive."
              : "Select or create a project before inspecting payment operations."}
          </p>
        </div>
      )}
    </PageContainer>
  );
}
