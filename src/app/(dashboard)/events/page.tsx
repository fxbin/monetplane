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
  const [context, params, dictionary] = await Promise.all([
    getConsoleContext(),
    searchParams,
    getDictionary(),
  ]);
  const t = dictionary.events;
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
  const events = await getDeveloperEvents(
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
      <div className="context-notice">
        <span className="context-notice-label">{t.privacyLabel}</span>
        <strong>{t.privacyStrong}</strong>
        <span>{t.privacyBody}</span>
      </div>

      <form className="developer-filter-bar" method="get">
        <FilterTextField
          label={t.provider}
          name="provider"
          defaultValue={filters.provider}
          placeholder={t.providerPlaceholder}
        />
        <FilterTextField
          label={t.customer}
          name="customer"
          defaultValue={filters.customer}
          placeholder={t.customerPlaceholder}
        />
        <FilterTextField
          label={t.order}
          name="order"
          defaultValue={filters.order}
          placeholder="ord_…"
        />
        <FilterSelectField
          label={t.status}
          name="status"
          defaultValue={filters.status ?? ""}
          options={[
            { value: "", label: t.all },
            { value: "processed", label: "processed" },
            { value: "failed", label: "failed" },
            { value: "ignored", label: "ignored" },
            { value: "received", label: "received" },
          ]}
        />
        <FilterTextField
          label={t.type}
          name="type"
          defaultValue={filters.type}
          placeholder="payment.succeeded"
        />
        <FilterActions>
          <button className="btn btn-primary" type="submit">
            {dictionary.common.filter}
          </button>
          <Link className="btn btn-secondary" href="/events">
            {dictionary.common.reset}
          </Link>
        </FilterActions>
      </form>

      {events.length ? (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table developer-event-table">
              <thead>
                <tr>
                  <th>{t.thEvent}</th>
                  <th>{t.thProvider}</th>
                  <th>{t.thOrderCustomer}</th>
                  <th>{t.thStatus}</th>
                  <th>{t.thOccurred}</th>
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
          {formatMessage(t.empty, { environment: environmentLabel })}
        </div>
      )}
    </PageContainer>
  );
}
