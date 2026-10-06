import { PageContainer } from "@/components/layout/PageContainer";
import { EmptyState } from "@/components/ui/console";
import {
  FilterActions,
  FilterSelectField,
  FilterTextField,
} from "@/components/ui/forms";
import { formatMessage, getDictionary } from "@/i18n/server";
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
  const [context, params, dictionary] = await Promise.all([
    getConsoleContext(),
    searchParams,
    getDictionary(),
  ]);
  const t = dictionary.audit;
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;
  const scope = params.scope === "workspace" ? "workspace" : "project";

  if (!application && scope !== "workspace") {
    return (
      <PageContainer title={t.title} description={t.selectProjectDescription}>
        <EmptyState
          title={dictionary.common.noProjectTitle}
          description={dictionary.common.noProjectDescription}
        />
      </PageContainer>
    );
  }

  const from = params.from ? new Date(`${params.from}T00:00:00Z`) : undefined;
  const to = params.to ? new Date(`${params.to}T23:59:59Z`) : undefined;
  const entries = await listAuditEntries(
    scope === "workspace" ? null : (application?.id ?? null),
    {
      action: value(params, "action"),
      actor: value(params, "actor"),
      resourceType: value(params, "resource"),
      environment: scope === "workspace" ? undefined : context.environment,
      from: Number.isNaN(from?.getTime()) ? undefined : from,
      to: Number.isNaN(to?.getTime()) ? undefined : to,
      limit: 200,
    },
  );

  return (
    <PageContainer
      title={t.title}
      description={
        scope === "workspace"
          ? t.workspaceDescription
          : formatMessage(t.projectDescription, {
              application: application?.name ?? "",
              environment: environmentLabel,
            })
      }
    >
      <form className="developer-filters audit-filters" method="get">
        <FilterSelectField
          label={t.scope}
          name="scope"
          defaultValue={scope}
          options={[
            { value: "project", label: t.scopeProject },
            { value: "workspace", label: t.scopeWorkspace },
          ]}
        />
        <FilterTextField
          label={t.action}
          name="action"
          defaultValue={value(params, "action") ?? ""}
          placeholder="api_key.created"
        />
        <FilterTextField
          label={t.actor}
          name="actor"
          defaultValue={value(params, "actor") ?? ""}
          placeholder={t.actorPlaceholder}
        />
        <FilterTextField
          label={t.resourceType}
          name="resource"
          defaultValue={value(params, "resource") ?? ""}
          placeholder="provider_connection"
        />
        <FilterTextField
          label={t.from}
          name="from"
          type="date"
          defaultValue={value(params, "from") ?? ""}
        />
        <FilterTextField
          label={t.to}
          name="to"
          type="date"
          defaultValue={value(params, "to") ?? ""}
        />
        <FilterActions>
          <button className="btn btn-primary" type="submit">
            {dictionary.common.filter}
          </button>
          <a
            className="btn btn-secondary"
            href={scope === "workspace" ? "/audit?scope=workspace" : "/audit"}
          >
            {dictionary.common.reset}
          </a>
        </FilterActions>
      </form>

      {entries.length === 0 ? (
        <EmptyState title={t.emptyTitle} description={t.emptyDescription} />
      ) : (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thWhen}</th>
                  <th>{t.thAction}</th>
                  <th>{t.thActor}</th>
                  <th>{t.thResource}</th>
                  <th>{t.thCorrelation}</th>
                  <th>{t.thMetadata}</th>
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
