import { PageContainer } from "@/components/layout/PageContainer";
import { getProductList } from "@/modules/admin/queries";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const products = await getProductList();

  return (
    <PageContainer
      title="Products"
      description="Create and manage what your customers can buy."
      primaryAction={{ label: "Create product", href: "/products/new" }}
    >
      {products.length > 0 ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Application</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>{product.name}</td>
                    <td className="cell-mono">{product.key}</td>
                    <td className="cell-muted">
                      {product.applicationName ?? "—"}
                    </td>
                    <td>
                      <span className={`badge badge-${product.status}`}>
                        {product.status}
                      </span>
                    </td>
                    <td className="cell-muted">
                      {new Date(product.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
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
          </div>
        </div>
      )}
    </PageContainer>
  );
}
