import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { formatAmount } from "@/lib/format";
import { getConsoleContext } from "@/server/control-plane/context";
import { getProductBuilderList } from "@/server/control-plane/products";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  one_time: "One-time",
  subscription: "Subscription",
  credit_pack: "Credit pack",
  usage_based: "Usage-oriented",
};

export default async function ProductsPage() {
  const context = await getConsoleContext();
  const projectName = context.selectedApplication?.name;
  const products = context.selectedApplication
    ? await getProductBuilderList(
        context.selectedApplication.id,
        context.environment,
      )
    : [];
  const environmentLabel =
    context.environment === "test" ? "Sandbox" : "Production";

  return (
    <PageContainer
      title="Products"
      description={
        projectName
          ? `Create and manage what customers can buy in ${projectName}.`
          : "Create a project before adding products."
      }
      primaryAction={
        context.selectedApplication
          ? { label: "Create product", href: "/products/new" }
          : { label: "Create project", href: "/applications/new" }
      }
    >
      {products.length > 0 ? (
        <>
          <div className="catalog-summary-row">
            <div>
              <span className="builder-kicker">Current catalog</span>
              <strong>
                {products.length} product{products.length === 1 ? "" : "s"}
              </strong>
            </div>
            <p>
              Provider column shows the routing preference for{" "}
              {environmentLabel}. Catalog and benefit definitions remain
              project-scoped.
            </p>
          </div>

          <div className="card">
            <div className="table-wrapper">
              <table className="data-table product-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Type</th>
                    <th>Primary price</th>
                    <th>Benefits</th>
                    <th>{environmentLabel} provider</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((item) => {
                    const price = item.primaryPrice;
                    return (
                      <tr key={item.product.id}>
                        <td>
                          <Link
                            className="table-primary-link product-name-link"
                            href={`/products/${item.product.id}`}
                          >
                            {item.product.name}
                          </Link>
                          <code className="product-key-inline">
                            {item.product.key}
                          </code>
                        </td>
                        <td>
                          <span className="product-type-pill">
                            {item.productType
                              ? (TYPE_LABELS[item.productType] ??
                                item.productType)
                              : "Legacy"}
                          </span>
                        </td>
                        <td>
                          {price ? (
                            <div className="product-price-cell">
                              <strong>
                                {formatAmount(
                                  price.amountMinor,
                                  price.currency,
                                )}
                              </strong>
                              <span>
                                {price.billingType === "recurring"
                                  ? `/${price.recurringInterval === "year" ? "year" : "month"}`
                                  : "one time"}
                              </span>
                            </div>
                          ) : (
                            <span className="cell-muted">No active price</span>
                          )}
                        </td>
                        <td>
                          <div className="benefit-chip-row">
                            {item.creditGrants.length > 0 && (
                              <span className="benefit-chip credit">
                                {item.creditGrants.length} credit
                                {item.creditGrants.length === 1 ? "" : "s"}
                              </span>
                            )}
                            {item.featureGrants.length > 0 && (
                              <span className="benefit-chip feature">
                                {item.featureGrants.length} feature
                                {item.featureGrants.length === 1 ? "" : "s"}
                              </span>
                            )}
                            {item.creditGrants.length === 0 &&
                              item.featureGrants.length === 0 && (
                                <span className="cell-muted">None</span>
                              )}
                          </div>
                        </td>
                        <td>
                          {item.provider ? (
                            <div className="product-provider-cell">
                              <strong>{item.provider.name}</strong>
                              <span>{item.provider.provider}</span>
                            </div>
                          ) : (
                            <span className="routing-missing">
                              Not configured
                            </span>
                          )}
                        </td>
                        <td>
                          <span
                            className={`badge badge-${item.product.status}`}
                          >
                            {item.product.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <h2 className="empty-state-title">
            {context.selectedApplication
              ? "Create your first product"
              : "Create a project first"}
          </h2>
          <p className="empty-state-desc">
            {context.selectedApplication
              ? "Use the guided builder to configure a price, credit grants, feature entitlements, and a payment provider without editing raw catalog records."
              : "Products are always owned by a MonetPlane project so catalog state stays isolated."}
          </p>
          <div className="empty-state-actions">
            <Link
              className="btn btn-primary"
              href={
                context.selectedApplication
                  ? "/products/new"
                  : "/applications/new"
              }
            >
              {context.selectedApplication
                ? "Create product"
                : "Create project"}
            </Link>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
