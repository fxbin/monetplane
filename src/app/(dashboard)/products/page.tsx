import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary } from "@/i18n/server";
import { formatAmount } from "@/lib/format";
import { getConsoleContext } from "@/server/control-plane/context";
import { getProductBuilderList } from "@/server/control-plane/products";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.products;
  const TYPE_LABELS: Record<string, string> = {
    one_time: t.typeOneTime,
    subscription: t.typeSubscription,
    credit_pack: t.typeCreditPack,
    usage_based: t.typeUsage,
  };
  const projectName = context.selectedApplication?.name;
  const products = context.selectedApplication
    ? await getProductBuilderList(
        context.selectedApplication.id,
        context.environment,
      )
    : [];
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

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
      primaryAction={
        context.selectedApplication
          ? { label: t.createProduct, href: "/products/new" }
          : { label: t.createProject, href: "/applications/new" }
      }
    >
      {products.length > 0 ? (
        <>
          <div className="catalog-summary-row">
            <div>
              <span className="builder-kicker">{t.catalogKicker}</span>
              <strong>
                {formatMessage(t.productsCount, {
                  count: String(products.length),
                })}
              </strong>
            </div>
            <p>
              {formatMessage(t.catalogNote, { environment: environmentLabel })}
            </p>
          </div>

          <div className="card">
            <div className="table-wrapper">
              <table className="data-table product-table">
                <thead>
                  <tr>
                    <th>{t.thProduct}</th>
                    <th>{t.thType}</th>
                    <th>{t.thPrice}</th>
                    <th>{t.thBenefits}</th>
                    <th>
                      {formatMessage(t.thProvider, {
                        environment: environmentLabel,
                      })}
                    </th>
                    <th>{t.thStatus}</th>
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
                              : t.typeLegacy}
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
                                  ? price.recurringInterval === "year"
                                    ? t.perYear
                                    : t.perMonth
                                  : t.oneTime}
                              </span>
                            </div>
                          ) : (
                            <span className="cell-muted">
                              {t.noActivePrice}
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="benefit-chip-row">
                            {item.creditGrants.length > 0 && (
                              <span className="benefit-chip credit">
                                {formatMessage(t.creditsCount, {
                                  count: String(item.creditGrants.length),
                                })}
                              </span>
                            )}
                            {item.featureGrants.length > 0 && (
                              <span className="benefit-chip feature">
                                {formatMessage(t.featuresCount, {
                                  count: String(item.featureGrants.length),
                                })}
                              </span>
                            )}
                            {item.creditGrants.length === 0 &&
                              item.featureGrants.length === 0 && (
                                <span className="cell-muted">{t.none}</span>
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
                              {t.notConfigured}
                            </span>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={item.product.status} />
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
              ? t.emptyTitleWithProject
              : t.emptyTitleNoProject}
          </h2>
          <p className="empty-state-desc">
            {context.selectedApplication
              ? t.emptyDescWithProject
              : t.emptyDescNoProject}
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
              {context.selectedApplication ? t.createProduct : t.createProject}
            </Link>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
