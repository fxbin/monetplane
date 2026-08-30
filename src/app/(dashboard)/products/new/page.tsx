import Link from "next/link";
import { ProductBuilderWizard } from "@/components/products/ProductBuilderWizard";
import { PageContainer } from "@/components/layout/PageContainer";
import { getConsoleContext } from "@/server/control-plane/context";
import { getBuilderProviderOptions } from "@/server/control-plane/products";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const context = await getConsoleContext();

  if (!context.selectedApplication) {
    return (
      <PageContainer
        title="Create product"
        description="Products must belong to a project."
      >
        <div className="empty-state">
          <h2 className="empty-state-title">Create a project first</h2>
          <p className="empty-state-desc">
            A MonetPlane project is the isolation boundary for catalog, customers,
            providers, entitlements, and credits.
          </p>
          <div className="empty-state-actions">
            <Link className="btn btn-primary" href="/applications/new">
              Create project
            </Link>
          </div>
        </div>
      </PageContainer>
    );
  }

  const providers = await getBuilderProviderOptions(
    context.selectedApplication.id,
    context.environment,
  );

  return (
    <PageContainer
      title="Create product"
      description={`Build a sellable catalog product for ${context.selectedApplication.name}.`}
    >
      <ProductBuilderWizard
        project={{
          id: context.selectedApplication.id,
          name: context.selectedApplication.name,
          slug: context.selectedApplication.slug,
        }}
        environment={context.environment}
        providers={providers.map((provider) => ({
          id: provider.id,
          provider: provider.provider,
          name: provider.name,
          mode: provider.mode,
        }))}
      />
    </PageContainer>
  );
}
