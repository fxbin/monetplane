import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProductProviderRouteEditor } from "@/components/products/ProductProviderRouteEditor";
import { StatusBadge } from "@/components/ui/console";
import { formatAmount, formatDateTime } from "@/lib/format";
import { getConsoleContext } from "@/server/control-plane/context";
import {
  getBuilderProviderOptions,
  getProductBuilderDetail,
} from "@/server/control-plane/products";

export const dynamic = "force-dynamic";

type ProductDetailPageProps = {
  params: Promise<{ productId: string }>;
};

const TYPE_LABELS: Record<string, string> = {
  one_time: "One-time purchase",
  subscription: "Subscription",
  credit_pack: "Credit pack",
  usage_based: "Usage-oriented plan",
};

export default async function ProductDetailPage({
  params,
}: ProductDetailPageProps) {
  const { productId } = await params;
  const context = await getConsoleContext();
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
    : "Legacy catalog product";
  const environmentLabel =
    context.environment === "test" ? "Sandbox" : "Production";

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

  return (
    <PageContainer
      title={detail.product.name}
      description={
        detail.product.description ??
        `Catalog product in ${context.selectedApplication.name}.`
      }
      primaryAction={{ label: "Back to products", href: "/products" }}
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
            Created {formatDateTime(detail.product.createdAt)} · Project{" "}
            {context.selectedApplication.name}
          </p>
        </div>

        <div className="product-detail-price">
          <span>Primary price</span>
          {price ? (
            <>
              <strong>{formatAmount(price.amountMinor, price.currency)}</strong>
              <small>
                {price.billingType === "recurring"
                  ? `per ${price.recurringInterval === "year" ? "year" : "month"}`
                  : "one time"}
              </small>
            </>
          ) : (
            <strong>Not configured</strong>
          )}
        </div>
      </div>

      <div className="product-detail-grid">
        <section className="card product-detail-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">Benefits</span>
              <h2 className="card-title">Credits & features</h2>
            </div>
          </div>

          {detail.creditGrants.length === 0 &&
          detail.featureGrants.length === 0 ? (
            <p className="card-empty-copy">
              No grants configured for this product.
            </p>
          ) : (
            <div className="grant-summary-list">
              {detail.creditGrants.map((grant) => (
                <div key={grant.id} className="grant-summary-row">
                  <span className="grant-kind credit">Credit</span>
                  <div>
                    <strong>{grant.referenceKey}</strong>
                    <span>{grant.quantity ?? 0} units granted</span>
                  </div>
                </div>
              ))}
              {detail.featureGrants.map((grant) => (
                <div key={grant.id} className="grant-summary-row">
                  <span className="grant-kind feature">Feature</span>
                  <div>
                    <strong>{grant.referenceKey}</strong>
                    <span>Entitlement unlocked</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card product-detail-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">{environmentLabel} routing</span>
              <h2 className="card-title">Preferred payment provider</h2>
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
                  detail.provider.mode === "test" ? "Sandbox" : "Production"
                }
              />
            </div>
          ) : (
            <div className="provider-missing-route">
              <strong>No provider preference in {environmentLabel}</strong>
              <p>
                This can happen for legacy products or when the product was
                first created in the other environment.
              </p>
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
          />

          <p className="product-routing-note">
            The checkout contract still accepts an explicit provider connection
            ID. This routing preference keeps the intended provider visible and
            copyable without implying full environment-scoped routing is
            available in this release.
          </p>
        </section>
      </div>

      <section className="card product-detail-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Checkout reference</span>
            <h2 className="card-title">Use these catalog IDs</h2>
          </div>
        </div>
        {checkoutPayload ? (
          <div className="checkout-reference-grid">
            <dl className="product-id-list">
              <div>
                <dt>Product ID</dt>
                <dd>
                  <code>{detail.product.id}</code>
                </dd>
              </div>
              <div>
                <dt>Price ID</dt>
                <dd>
                  <code>{price?.id}</code>
                </dd>
              </div>
              <div>
                <dt>Provider connection</dt>
                <dd>
                  <code>{detail.providerConnectionId ?? "Not configured"}</code>
                </dd>
              </div>
            </dl>
            <div className="checkout-payload">
              <span>Checkout input shape</span>
              <pre>
                <code>{checkoutPayload}</code>
              </pre>
            </div>
          </div>
        ) : (
          <p className="card-empty-copy">
            Create an active price before starting checkout.
          </p>
        )}
      </section>
    </PageContainer>
  );
}
