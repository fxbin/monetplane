import { PageContainer } from "@/components/layout/PageContainer";
import { EmptyState } from "@/components/ui/console";
import { listAuditEntries } from "@/server/control-plane/audit";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function value(
  params: Record<string, string | string[] | undefined>,
  key: string,
) {
  const raw = params[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export default async function AuditPage({
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
        title="Audit log"
        description="Select a project to review operator activity."
      >
        <EmptyState
          title="No project selected"
          description="Create or select a project first."
        />
      </PageContainer>
    );
  }

  const from = params.from ? new Date(`${params.from}T00:00:00Z`) : undefined;
  const to = params.to ? new Date(`${params.to}T23:59:59Z`) : undefined;
  const entries = await listAuditEntries(application.id, {
    action: value(params, "action"),
    actor: value(params, "actor"),
    resourceType: value(params, "resource"),
    environment: context.environment,
    from: Number.isNaN(from?.getTime()) ? undefined : from,
    to: Number.isNaN(to?.getTime()) ? undefined : to,
    limit: 200,
  });

  return (
    <PageContainer
      title="Audit log"
      description={`Immutable operator activity for ${application.name} · ${environmentLabel}. Secrets are never recorded.`}
    >
      <form className="developer-filters" method="get">
        <label>
          <span>Action</span>
          <input
            name="action"
            defaultValue={value(params, "action") ?? ""}
            placeholder="api_key.created"
          />
        </label>
        <label>
          <span>Actor</span>
          <input
            name="actor"
            defaultValue={value(params, "actor") ?? ""}
            placeholder="admin id or email"
          />
        </label>
        <label>
          <span>Resource type</span>
          <input
            name="resource"
            defaultValue={value(params, "resource") ?? ""}
            placeholder="provider_connection"
          />
        </label>
        <label>
          <span>From</span>
          <input
            type="date"
            name="from"
            defaultValue={value(params, "from") ?? ""}
          />
        </label>
        <label>
          <span>To</span>
          <input
            type="date"
            name="to"
            defaultValue={value(params, "to") ?? ""}
          />
        </label>
        <div className="developer-filter-actions">
          <button className="btn btn-primary" type="submit">
            Filter
          </button>
          <a className="btn btn-secondary" href="/audit">
            Reset
          </a>
        </div>
      </form>

      {entries.length === 0 ? (
        <EmptyState
          title="No audit entries match this view"
          description="Sensitive console mutations are recorded here automatically."
        />
      ) : (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Resource</th>
                  <th>Correlation</th>
                  <th>Metadata</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="cell-muted">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="cell-mono">{entry.action}</td>
                    <td>{entry.actorLabel ?? entry.actorId}</td>
                    <td className="cell-mono">
                      {entry.resourceType}/{entry.resourceId.slice(0, 18)}
                    </td>
                    <td className="cell-mono cell-muted">
                      {entry.correlationId?.slice(0, 16) ?? "—"}
                    </td>
                    <td
                      className="cell-mono cell-muted"
                      style={{ maxWidth: 260 }}
                    >
                      {JSON.stringify(entry.metadata).slice(0, 120)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
