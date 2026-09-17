import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { getConsoleContext } from "@/server/control-plane/context";
import { getDeveloperEvents } from "@/server/control-plane/developer";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function value(
  params: Record<string, string | string[] | undefined>,
  key: string,
) {
  const candidate = params[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [context, params] = await Promise.all([
    getConsoleContext(),
    searchParams,
  ]);
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test" ? "Sandbox" : "Production";

  if (!application) {
    return (
      <PageContainer
        title="Events"
        description="Provider events will appear after you create a project."
      >
        <div className="empty-state">
          <h2 className="empty-state-title">No project selected</h2>
          <p className="empty-state-desc">
            Create a project to inspect normalized payment and subscription
            events.
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

  const filters = {
    provider: value(params, "provider") || undefined,
    customer: value(params, "customer") || undefined,
    order: value(params, "order") || undefined,
    status: value(params, "status") || undefined,
    type: value(params, "type") || undefined,
  };
  const events = await getDeveloperEvents(
    application.id,
    context.environment,
    filters,
  );

  return (
    <PageContainer
      title="Events"
      description={`Normalized ${environmentLabel} provider events for ${application.name}.`}
    >
      <div className="context-notice">
        <span className="context-notice-label">Privacy boundary</span>
        <strong>Normalized events only</strong>
        <span>
          Raw provider webhook bodies are retained for processing but are not
          exposed in this developer console.
        </span>
      </div>

      <form className="developer-filter-bar" method="get">
        <label>
          <span>Provider</span>
          <input
            name="provider"
            defaultValue={filters.provider}
            placeholder="waffo or pc_…"
          />
        </label>
        <label>
          <span>Customer</span>
          <input
            name="customer"
            defaultValue={filters.customer}
            placeholder="external or internal id"
          />
        </label>
        <label>
          <span>Order</span>
          <input
            name="order"
            defaultValue={filters.order}
            placeholder="ord_…"
          />
        </label>
        <label>
          <span>Status</span>
          <select name="status" defaultValue={filters.status ?? ""}>
            <option value="">All</option>
            <option value="processed">Processed</option>
            <option value="failed">Failed</option>
            <option value="ignored">Ignored</option>
            <option value="received">Received</option>
          </select>
        </label>
        <label>
          <span>Type</span>
          <input
            name="type"
            defaultValue={filters.type}
            placeholder="payment.succeeded"
          />
        </label>
        <div className="developer-filter-actions">
          <button className="btn btn-primary" type="submit">
            Filter
          </button>
          <Link className="btn btn-secondary" href="/events">
            Reset
          </Link>
        </div>
      </form>

      {events.length ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table developer-event-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Provider</th>
                  <th>Order / Customer</th>
                  <th>Status</th>
                  <th>Occurred</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <strong>{event.type}</strong>
                      <div className="cell-muted cell-mono">
                        {event.providerEventId}
                      </div>
                      <div className="cell-muted">
                        {event.providerEventName}
                      </div>
                    </td>
                    <td>
                      <div>{event.provider}</div>
                      <div className="cell-muted cell-mono">
                        {event.providerConnectionId}
                      </div>
                    </td>
                    <td>
                      <div className="cell-mono">{event.orderId ?? "—"}</div>
                      <div className="cell-muted cell-mono">
                        {event.customerId ?? "—"}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={event.status} />
                      {event.errorMessage && (
                        <div className="delivery-error-message">
                          {event.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="cell-muted">
                      {new Date(event.occurredAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="developer-empty developer-empty-large">
          No events match this {environmentLabel} view yet. Provider-signed
          webhook events will appear here after normalization.
        </div>
      )}
    </PageContainer>
  );
}
