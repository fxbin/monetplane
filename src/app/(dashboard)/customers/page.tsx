import { PageContainer } from "@/components/layout/PageContainer";

export default function CustomersPage() {
  return (
    <PageContainer
      title="Customers"
      description="Inspect customer billing state, credit balances, and payment history."
    >
      <div className="empty-state">
        <h2 className="empty-state-title">No customers yet</h2>
        <p className="empty-state-desc">
          Customers appear here once they complete a checkout or are created
          through the SDK.
        </p>
      </div>
    </PageContainer>
  );
}
