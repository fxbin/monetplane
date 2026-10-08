import { PageContainer } from "@/components/layout/PageContainer";
import { formatMessage, getDictionary, getLocaleTag } from "@/i18n/server";
import { formatDateTime } from "@/lib/format";
import { getConsoleContext } from "@/server/control-plane/context";
import { getCreditsOverview } from "@/server/control-plane/credits-overview";

export const dynamic = "force-dynamic";

/**
 * Credits overview (roundtable 2026-10-06, PR3). Four blocks: balances by
 * credit type, recent 7-day ledger activity, buckets expiring within 30
 * days, and active reservations (with the explicit "no auto-release"
 * warning — the reservation sweeper is a separate deferred item). The
 * credit-type list is derived from the accounts themselves (无目录方案);
 * the registry is deferred until a second real need exists.
 */
export default async function CreditsPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const localeTag = await getLocaleTag();
  const fmtDateTime = (d: Date | string) => formatDateTime(d, localeTag);
  const t = dictionary.creditsOverview;
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  if (!application) {
    return (
      <PageContainer title={t.title} description={t.noProjectDescription}>
        <p className="cell-muted">{dictionary.common.noProjectDescription}</p>
      </PageContainer>
    );
  }

  const overview = await getCreditsOverview(
    application.id,
    context.environment,
  );

  return (
    <PageContainer
      title={t.title}
      description={formatMessage(t.description, {
        application: application.name,
        environment: environmentLabel,
      })}
    >
      <section className="card">
        <h2 className="card-title">{t.typesTitle}</h2>
        {overview.typeSummaries.length === 0 ? (
          <p className="cell-muted">{t.typesEmpty}</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thType}</th>
                  <th>{t.thCustomers}</th>
                  <th>{t.thAvailable}</th>
                  <th>{t.thReserved}</th>
                </tr>
              </thead>
              <tbody>
                {overview.typeSummaries.map((row) => (
                  <tr key={row.creditType}>
                    <td className="cell-mono">{row.creditType}</td>
                    <td>{row.customers}</td>
                    <td>{row.available.toLocaleString()}</td>
                    <td>{row.reserved.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">{t.ledgerTitle}</h2>
        {overview.recentLedger.length === 0 ? (
          <p className="cell-muted">{t.ledgerEmpty}</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thEntry}</th>
                  <th>{t.thCustomer}</th>
                  <th>{t.thAmount}</th>
                  <th>{t.thSource}</th>
                  <th>{t.thWhen}</th>
                </tr>
              </thead>
              <tbody>
                {overview.recentLedger.map((entry) => (
                  <tr key={entry.id}>
                    <td className="cell-mono">{entry.creditType}</td>
                    <td>{entry.customer ?? "—"}</td>
                    <td
                      className={entry.amount > 0 ? "is-positive" : undefined}
                    >
                      {entry.amount > 0 ? "+" : ""}
                      {entry.amount.toLocaleString()}
                    </td>
                    <td className="cell-muted">{entry.type}</td>
                    <td className="cell-muted">
                      {fmtDateTime(entry.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">{t.expiringTitle}</h2>
        {overview.expiringBuckets.length === 0 ? (
          <p className="cell-muted">{t.expiringEmpty}</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thBucket}</th>
                  <th>{t.thCustomer}</th>
                  <th>{t.thRemaining}</th>
                  <th>{t.thExpires}</th>
                </tr>
              </thead>
              <tbody>
                {overview.expiringBuckets.map((bucket) => (
                  <tr key={bucket.id}>
                    <td className="cell-mono">{bucket.creditType}</td>
                    <td>{bucket.customer ?? "—"}</td>
                    <td>{bucket.remaining.toLocaleString()}</td>
                    <td className="cell-muted">
                      {bucket.expiresAt ? fmtDateTime(bucket.expiresAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">{t.reservationsTitle}</h2>
        <div className="context-notice">
          <span className="context-notice-label">{t.reservationWarning}</span>
        </div>
        {overview.activeReservations.length === 0 ? (
          <p className="cell-muted">{t.reservationsEmpty}</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thReservation}</th>
                  <th>{t.thCustomer}</th>
                  <th>{t.thReservedAmount}</th>
                  <th>{t.thReference}</th>
                  <th>{t.thWhen}</th>
                </tr>
              </thead>
              <tbody>
                {overview.activeReservations.map((reservation) => (
                  <tr key={reservation.id}>
                    <td className="cell-mono">{reservation.creditType}</td>
                    <td>{reservation.customer ?? "—"}</td>
                    <td>{reservation.reservedAmount.toLocaleString()}</td>
                    <td className="cell-muted">
                      {reservation.referenceType}/{reservation.referenceId}
                    </td>
                    <td className="cell-muted">
                      {fmtDateTime(reservation.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PageContainer>
  );
}
