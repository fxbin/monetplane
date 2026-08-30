import { PageContainer } from "@/components/layout/PageContainer";
import { getProductList } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const context = await getConsoleContext();
  const products = await getProductList(context.selectedApplication?.id);
  const projectName = context.selectedApplication?.name;

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
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>{product.name}</td>
                    <td className="cell-mono">{product.key}</td>
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
          <h2 className="empty-state-title">
            {context.selectedApplication ? "Create your first product" : "Create a project first"}
          </h2>
          <p className="empty-state-desc">
            {context.selectedApplication
              ? "Products define what your customers can buy, including one-time payments, subscriptions, and credit packs."
              : "Products are always owned by a MonetPlane project so catalog state stays isolated."}
          </p>
          <div className="empty-state-actions">
            <a
              className="btn btn-primary"
              href={context.selectedApplication ? "/products/new" : "/applications/new"}
            >
              {context.selectedApplication ? "Create product" : "Create project"}
            </a>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
