import { redirect } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProviderConnectForm } from "@/components/providers/ProviderConnectForm";
import { formatMessage, getDictionary } from "@/i18n/server";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function NewProviderPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.providersNew;
  if (!context.selectedApplication) redirect("/applications/new");

  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  return (
    <PageContainer
      title={t.title}
      description={formatMessage(t.description, {
        environment: environmentLabel,
        application: context.selectedApplication.name,
      })}
      primaryAction={{ label: t.back, href: "/providers" }}
    >
      <div className="context-notice provider-connect-context">
        <span className="context-notice-label">{t.noticeLabel}</span>
        <strong>{context.selectedApplication.name}</strong>
        <span>·</span>
        <strong>{environmentLabel}</strong>
        <span>{t.noticeBody}</span>
      </div>

      <ProviderConnectForm
        projectName={context.selectedApplication.name}
        environment={context.environment}
        labels={t}
      />
    </PageContainer>
  );
}
