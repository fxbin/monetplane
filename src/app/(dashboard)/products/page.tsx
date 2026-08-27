import { PageContainer } from "@/components/layout/PageContainer";

export default function ProductsPage() {
  return (
    <PageContainer
      title="Products"
      description="Create and manage what your customers can buy."
      primaryAction={{ label: "Create product", href: "/products/new" }}
    >
      <div className="empty-state">
        <h2 className="empty-state-title">Create your first product</h2>
        <p className="empty-state-desc">
          Products define what your customers can buy, including one-time
          payments, subscriptions, and credit packs.
        </p>
        <div className="empty-state-actions">
          <a className="btn btn-primary" href="/products/new">
            Create product
          </a>
          <a className="btn btn-secondary" href="/docs/products">
            View docs
          </a>
        </div>
      </div>
    </PageContainer>
  );
}
