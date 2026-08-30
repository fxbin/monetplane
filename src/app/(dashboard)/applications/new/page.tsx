import { ApplicationCreateForm } from "@/components/applications/ApplicationCreateForm";
import { PageContainer } from "@/components/layout/PageContainer";

export default function NewApplicationPage() {
  return (
    <PageContainer
      title="Create project"
      description="Create an isolated MonetPlane billing boundary, then connect a provider and add products."
    >
      <ApplicationCreateForm />
    </PageContainer>
  );
}
