import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { getConsoleContext } from "@/server/control-plane/context";
import { getDeveloperLogs } from "@/server/control-plane/developer";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function value(
  params: Record<string, string | string[] | undefined>,
  key: string,
) {
  const candidate = params[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

export default async function LogsPage({
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
        title="Logs"
        description="Operational logs will appear after you create a project."
      >
        <div className="empty-state">
          <h2 className="empty-state-title">No project selected</h2>
          <p className="empty-state-desc">
            Create a project to inspect billing operations and webhook delivery
            health.
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
  const logs = await getDeveloperLogs(
    application.id,
    context.environment,
    filters,
  );

  return (
    <PageContainer
      title="Logs"
      description={`Operational ${environmentLabel} activity for ${application.name}.`}
    >
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
            placeholder="user_123"
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
          <span>Source</span>
          <select name="type" defaultValue={filters.type ?? ""}>
            <option value="">All</option>
            <option value="provider_webhook">Provider webhook</option>
            <option value="billing_operation">Billing operation</option>
            <option value="developer_webhook">Developer webhook</option>
          </select>
        </label>
        <label>
          <span>Status</span>
          <input
            name="status"
            defaultValue={filters.status}
            placeholder="failed, completed…"
          />
        </label>
        <div className="developer-filter-actions">
          <button className="btn btn-primary" type="submit">
            Filter
          </button>
          <Link className="btn btn-secondary" href="/logs">
            Reset
          </Link>
        </div>
      </form>

      {logs.length ? (
        <div className="developer-log-list">
          {logs.map((log) => (
            <article className="developer-log-row" key={log.id}>
              <span
                className={`developer-log-level level-${log.level}`}
                aria-hidden="true"
              />
              <div className="developer-log-copy">
                <div className="developer-log-title">
                  <strong>{log.message}</strong>
                  <span className="developer-log-source">
                    {log.source.replaceAll("_", " ")}
                  </span>
                  <span className={`badge badge-${log.status}`}>
                    {log.status}
                  </span>
                </div>
                <div className="developer-log-meta">
                  {log.provider && <span>provider {log.provider}</span>}
                  {log.providerConnectionId && (
                    <span className="cell-mono">
                      {log.providerConnectionId}
                    </span>
                  )}
                  {log.externalCustomerId && (
                    <span>
                      customer{" "}
                      <span className="cell-mono">
                        {log.externalCustomerId}
                      </span>
                    </span>
                  )}
                  {log.orderId && (
                    <span>
                      order <span className="cell-mono">{log.orderId}</span>
                    </span>
                  )}
                </div>
              </div>
              <time>{new Date(log.createdAt).toLocaleString()}</time>
            </article>
          ))}
        </div>
      ) : (
        <div className="developer-empty developer-empty-large">
          No operational logs match these filters in {environmentLabel}.
        </div>
      )}
    </PageContainer>
  );
}
