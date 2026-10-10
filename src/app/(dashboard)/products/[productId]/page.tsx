import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProductProviderRouteEditor } from "@/components/products/ProductProviderRouteEditor";
import { ProviderCatalogPanel } from "@/components/products/ProviderCatalogPanel";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary, getLocaleTag } from "@/i18n/server";
import { formatAmount, formatDate, formatDateTime } from "@/lib/format";
import { getConsoleContext } from "@/server/control-plane/context";
import {
  getBuilderProviderOptions,
  getProductBuilderDetail,
} from "@/server/control-plane/products";

export const dynamic = "force-dynamic";

type ProductDetailPageProps = {
  params: Promise<{ productId: string }>;
};

export default async function ProductDetailPage({
  params,
}: ProductDetailPageProps) {
  const { productId } = await params;
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const localeTag = await getLocaleTag();
  const fmtDateTime = (d: Date | string) => formatDateTime(d, localeTag);
  const t = dictionary.productsDetail;
  const TYPE_LABELS: Record<string, string> = {
    one_time: t.typeOneTime,
    subscription: t.typeSubscription,
    credit_pack: t.typeCreditPack,
    usage_based: t.typeUsage,
  };
  if (!context.selectedApplication) notFound();

  const [detail, providerOptions] = await Promise.all([
    getProductBuilderDetail(
      context.selectedApplication.id,
      productId,
      context.environment,
    ),
    getBuilderProviderOptions(
      context.selectedApplication.id,
      context.environment,
    ),
  ]);
  if (!detail) notFound();

  const price = detail.primaryPrice;
  const typeLabel = detail.productType
    ? (TYPE_LABELS[detail.productType] ?? detail.productType)
    : t.typeLegacy;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  const checkoutPayload = price
    ? JSON.stringify(
        {
          providerConnectionId:
            detail.providerConnectionId ?? "<choose-provider>",
          items: [{ priceId: price.id, quantity: 1 }],
          successUrl: "https://your-app.example/success",
          cancelUrl: "https://your-app.example/cancel",
        },
        null,
        2,
      )
    : null;

  const catalogLinkPrices = detail.prices.map((priceOption) => {
    const intervalSuffix =
      priceOption.billingType === "recurring"
        ? priceOption.recurringInterval === "year"
          ? t.perYear
          : t.perMonth
        : t.oneTime;
    return {
      id: priceOption.id,
      label: `${priceOption.key} · ${formatAmount(
        priceOption.amountMinor,
        priceOption.currency,
      )} ${intervalSuffix}`,
    };
  });
  const catalogLinkMappings = detail.catalogMappings.map((mapping) => ({
    monetplanePriceId: mapping.monetplanePriceId,
    providerConnectionId: mapping.providerConnectionId,
    providerProductId: mapping.providerProductId,
    source: mapping.source,
    status: mapping.status,
    lastVerifiedLabel: mapping.lastVerifiedAt
      ? formatDateTime(mapping.lastVerifiedAt, localeTag)
      : null,
  }));

  return (
    <PageContainer
      title={detail.product.name}
      description={
        detail.product.description ??
        formatMessage(t.defaultDescription, {
          application: context.selectedApplication.name,
        })
      }
      primaryAction={{ label: t.backToProducts, href: "/products" }}
    >
      <div className="product-detail-hero card">
        <div className="product-detail-identity">
          <span className="builder-kicker">{typeLabel}</span>
          <div className="product-detail-title-row">
            <h2>{detail.product.name}</h2>
            <StatusBadge status={detail.product.status} />
          </div>
          <code>{detail.product.key}</code>
          <p>
            {formatMessage(t.createdAt, {
              date: fmtDateTime(detail.product.createdAt),
              application: context.selectedApplication.name,
            })}
          </p>
        </div>

        <div className="product-detail-price">
          <span>{t.primaryPrice}</span>
          {price ? (
            <>
              <strong>{formatAmount(price.amountMinor, price.currency)}</strong>
              <small>
                {price.billingType === "recurring"
                  ? price.recurringInterval === "year"
                    ? t.perYear
                    : t.perMonth
                  : t.oneTime}
              </small>
            </>
          ) : (
            <strong>{t.notConfigured}</strong>
          )}
        </div>
      </div>

      <div className="product-detail-grid">
        <section className="card product-detail-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">{t.benefitsKicker}</span>
              <h2 className="card-title">{t.benefitsTitle}</h2>
            </div>
          </div>

          {detail.creditGrants.length === 0 &&
          detail.featureGrants.length === 0 ? (
            <p className="card-empty-copy">{t.noGrants}</p>
          ) : (
            <div className="grant-summary-list">
              {detail.creditGrants.map((grant) => (
                <div key={grant.id} className="grant-summary-row">
                  <span className="grant-kind credit">{t.creditKind}</span>
                  <div>
                    <strong>{grant.referenceKey}</strong>
                    <span>
                      {formatMessage(t.unitsGranted, {
                        count: String(grant.quantity ?? 0),
                      })}
                    </span>
                  </div>
                </div>
              ))}
              {detail.featureGrants.map((grant) => (
                <div key={grant.id} className="grant-summary-row">
                  <span className="grant-kind feature">{t.featureKind}</span>
                  <div>
                    <strong>{grant.referenceKey}</strong>
                    <span>{t.entitlementUnlocked}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card product-detail-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">
                {formatMessage(t.routingKicker, {
                  environment: environmentLabel,
                })}
              </span>
              <h2 className="card-title">{t.routingTitle}</h2>
            </div>
          </div>

          {detail.provider ? (
            <div className="provider-detail-card">
              <div className="provider-mark">
                {detail.provider.provider.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <strong>{detail.provider.name}</strong>
                <span>{detail.provider.provider}</span>
                <code>{detail.provider.id}</code>
              </div>
              <StatusBadge
                status={detail.provider.mode}
                label={
                  detail.provider.mode === "test"
                    ? dictionary.common.sandbox
                    : dictionary.common.production
                }
              />
            </div>
          ) : (
            <div className="provider-missing-route">
              <strong>
                {formatMessage(t.noProviderTitle, {
                  environment: environmentLabel,
                })}
              </strong>
              <p>{t.noProviderDesc}</p>
            </div>
          )}

          <ProductProviderRouteEditor
            productId={detail.product.id}
            environment={context.environment}
            currentProviderConnectionId={detail.providerConnectionId}
            providers={providerOptions.map((provider) => ({
              id: provider.id,
              provider: provider.provider,
              name: provider.name,
              mode: provider.mode,
            }))}
            labels={dictionary.routeEditor}
          />

          <p className="product-routing-note">{t.routingNote}</p>
        </section>
      </div>

      <section className="card product-detail-section">
        {/* Keyed by the verification identity scope: switching the routed
            provider connection or the console environment remounts the
            panel, so no state (verification, in-flight request, message)
            survives an identity change. */}
        <ProviderCatalogPanel
          key={`${context.environment}:${detail.providerConnectionId ?? "none"}`}
          applicationName={context.selectedApplication.name}
          environment={context.environment}
          providerSupportsCreate={detail.providerSupportsCatalogCreate}
          connection={
            detail.provider
              ? {
                  id: detail.provider.id,
                  name: detail.provider.name,
                  provider: detail.provider.provider,
                }
              : null
          }
          prices={catalogLinkPrices}
          mappings={catalogLinkMappings}
          labels={dictionary.catalogLink}
        />
      </section>

      <section className="card product-detail-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">{t.checkoutKicker}</span>
            <h2 className="card-title">{t.checkoutTitle}</h2>
          </div>
        </div>
        {checkoutPayload ? (
          <div className="checkout-reference-grid">
            <dl className="product-id-list">
              <div>
                <dt>{t.productIdLabel}</dt>
                <dd>
                  <code>{detail.product.id}</code>
                </dd>
              </div>
              <div>
                <dt>{t.priceIdLabel}</dt>
                <dd>
                  <code>{price?.id}</code>
                </dd>
              </div>
              <div>
                <dt>{t.providerConnectionLabel}</dt>
                <dd>
                  <code>{detail.providerConnectionId ?? t.notConfigured}</code>
                </dd>
              </div>
            </dl>
            <div className="checkout-payload">
              <span>{t.checkoutShape}</span>
              <pre>
                <code>{checkoutPayload}</code>
              </pre>
            </div>
          </div>
        ) : (
          <p className="card-empty-copy">{t.createPriceFirst}</p>
        )}
      </section>
    </PageContainer>
  );
}
