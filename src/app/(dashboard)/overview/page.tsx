import { PageContainer } from "@/components/layout/PageContainer";

export default function OverviewPage() {
  return (
    <PageContainer
      title="Overview"
      description="Monitor revenue, payments, subscriptions, and provider health at a glance."
    >
      <div className="empty-state">
        <h2 className="empty-state-title">Welcome to MonetPlane</h2>
        <p className="empty-state-desc">
          Set up your billing control plane to start accepting payments,
          managing credits, and tracking subscriptions.
        </p>
        <div className="onboarding-checklist">
          <div className="onboarding-item">
            <span className="onboarding-number">1</span>
            <span>Connect a payment provider</span>
          </div>
          <div className="onboarding-item">
            <span className="onboarding-number">2</span>
            <span>Create your first product</span>
          </div>
          <div className="onboarding-item">
            <span className="onboarding-number">3</span>
            <span>Add the SDK to your application</span>
          </div>
          <div className="onboarding-item">
            <span className="onboarding-number">4</span>
            <span>Send your first event</span>
          </div>
          <div className="onboarding-item">
            <span className="onboarding-number">5</span>
            <span>Receive your first payment</span>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
