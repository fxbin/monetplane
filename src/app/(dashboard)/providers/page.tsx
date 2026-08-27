import { PageContainer } from "@/components/layout/PageContainer";

export default function ProvidersPage() {
  return (
    <PageContainer
      title="Payment Providers"
      description="Connect and monitor your payment provider integrations."
      primaryAction={{ label: "Connect provider", href: "/providers/new" }}
    >
      <div className="empty-state">
        <h2 className="empty-state-title">No providers connected</h2>
        <p className="empty-state-desc">
          Connect a payment provider to start accepting payments. MonetPlane
          supports Creem, Waffo, and custom providers through a shared contract.
        </p>
        <div className="empty-state-actions">
          <a className="btn btn-primary" href="/providers/new">
            Connect provider
          </a>
        </div>
      </div>
    </PageContainer>
  );
}
