import Link from "next/link";
import { BillingOperationsFilters } from "@/components/billing/BillingOperationsFilters";
import { PageContainer } from "@/components/layout/PageContainer";
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
  const [context, params] = await Promise.all([
    getConsoleContext(),
    searchParams,
  ]);
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
    <PageContainer
      title="Refunds"
      description="Track normalized refund state and trace each refund back to its payment, customer, product, and provider."
    >
      {applicationId && (
        <BillingOperationsFilters
          action="/refunds"
          filter={filter}
          providers={providers}
          statuses={[
            { value: "pending", label: "Pending" },
            { value: "succeeded", label: "Succeeded" },
            { value: "failed", label: "Failed" },
          ]}
        />
      )}

      {rows.length > 0 ? (
        <div className="card billing-table-card">
          <div className="table-wrapper">
            <table className="data-table billing-operations-table">
              <thead>
                <tr>
                  <th>Refund</th>
                  <th>Customer</th>
                  <th>Product</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Created</th>
                  <th aria-label="Open refund" />
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
                          {refund.externalCustomerId ?? "Customer"}
                        </Link>
                      ) : (
                        <span className="cell-muted">Unknown</span>
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
                      <span className={`badge badge-${refund.status}`}>
                        {refund.status}
                      </span>
                    </td>
                    <td>{refund.providerName ?? refund.provider ?? "—"}</td>
                    <td className="cell-muted">
                      {formatDateTime(refund.createdAt)}
                    </td>
                    <td>
                      <Link
                        className="table-row-link"
                        href={`/refunds/${refund.id}`}
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
            {applicationId
              ? "No refunds match this view"
              : "No project selected"}
          </h2>
          <p className="empty-state-desc">
            {applicationId
              ? "Adjust the filters or wait for refund activity."
              : "Select or create a project before inspecting refunds."}
          </p>
        </div>
      )}
    </PageContainer>
  );
}
