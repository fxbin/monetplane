import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProductBuilderWizard } from "@/components/products/ProductBuilderWizard";
import { formatMessage, getDictionary } from "@/i18n/server";
import { getConsoleContext } from "@/server/control-plane/context";
import { getBuilderProviderOptions } from "@/server/control-plane/products";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.productsNew;

  if (!context.selectedApplication) {
    return (
      <PageContainer title={t.title} description={t.noProjectDescription}>
        <div className="empty-state">
          <h2 className="empty-state-title">{t.emptyTitle}</h2>
          <p className="empty-state-desc">{t.emptyDesc}</p>
          <div className="empty-state-actions">
            <Link className="btn btn-primary" href="/applications/new">
              {t.createProject}
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
      title={t.title}
      description={formatMessage(t.description, {
        application: context.selectedApplication.name,
      })}
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
          capabilities: provider.capabilities,
        }))}
      />
    </PageContainer>
  );
}
