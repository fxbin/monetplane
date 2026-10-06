import { ApplicationCreateForm } from "@/components/applications/ApplicationCreateForm";
import { PageContainer } from "@/components/layout/PageContainer";
import { getDictionary } from "@/i18n/server";

export default async function NewApplicationPage() {
  const dictionary = await getDictionary();
  const t = dictionary.applicationsNew;

  return (
    <PageContainer title={t.title} description={t.description}>
      <ApplicationCreateForm labels={dictionary.applicationCreate} />
    </PageContainer>
  );
}
