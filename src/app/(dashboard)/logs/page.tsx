import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import {
  FilterActions,
  FilterSelectField,
  FilterTextField,
} from "@/components/ui/forms";
import { formatMessage, getDictionary } from "@/i18n/server";
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
  const [context, params, dictionary] = await Promise.all([
    getConsoleContext(),
    searchParams,
    getDictionary(),
  ]);
  const t = dictionary.logs;
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  if (!application) {
    return (
      <PageContainer title={t.title} description={t.noProjectDescription}>
        <div className="empty-state">
          <h2 className="empty-state-title">
            {dictionary.common.noProjectTitle}
          </h2>
          <p className="empty-state-desc">{t.emptyDesc}</p>
          <div className="empty-state-actions">
            <Link className="btn btn-primary" href="/applications/new">
              {t.createProject}
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
      title={t.title}
      description={formatMessage(t.description, {
        environment: environmentLabel,
        application: application.name,
      })}
    >
      <form className="developer-filter-bar" method="get">
        <FilterTextField
          label={t.provider}
          name="provider"
          defaultValue={filters.provider}
          placeholder="waffo or pc_…"
        />
        <FilterTextField
          label={t.customer}
          name="customer"
          defaultValue={filters.customer}
          placeholder="user_123"
        />
        <FilterTextField
          label={t.order}
          name="order"
          defaultValue={filters.order}
          placeholder="ord_…"
        />
        <FilterSelectField
          label={t.source}
          name="type"
          defaultValue={filters.type ?? ""}
          options={[
            { value: "", label: t.all },
            { value: "provider_webhook", label: t.sourceProviderWebhook },
            { value: "billing_operation", label: t.sourceBillingOperation },
            { value: "developer_webhook", label: t.sourceDeveloperWebhook },
          ]}
        />
        <FilterTextField
          label={t.status}
          name="status"
          defaultValue={filters.status}
          placeholder="failed, completed…"
        />
        <FilterActions>
          <button className="btn btn-primary" type="submit">
            {dictionary.common.filter}
          </button>
          <Link className="btn btn-secondary" href="/logs">
            {dictionary.common.reset}
          </Link>
        </FilterActions>
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
                  <StatusBadge status={log.status} />
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
          {formatMessage(t.empty, { environment: environmentLabel })}
        </div>
      )}
    </PageContainer>
  );
}
