import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary } from "@/i18n/server";
import { getConsoleApplicationDetail } from "@/server/control-plane/applications";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type ApplicationDetailPageProps = {
  params: Promise<{ applicationId: string }>;
};

export default async function ApplicationDetailPage({
  params,
}: ApplicationDetailPageProps) {
  const { applicationId } = await params;
  const [detail, context, dictionary] = await Promise.all([
    getConsoleApplicationDetail(applicationId),
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.applicationsDetail;

  if (!detail) notFound();

  const isCurrent = context.selectedApplication?.id === detail.application.id;
  const onboarding = [
    {
      label: t.onboarding.created,
      complete: true,
      href: `/applications/${detail.application.id}`,
    },
    {
      label: t.onboarding.keyCreated,
      complete: detail.credentials.some((credential) => !credential.revokedAt),
      href: `/applications/${detail.application.id}`,
    },
    {
      label: t.onboarding.connectProvider,
      complete: detail.counts.providers > 0,
      href: "/providers",
    },
    {
      label: t.onboarding.createProduct,
      complete: detail.counts.products > 0,
      href: "/products",
    },
    {
      label: t.onboarding.firstCustomer,
      complete: detail.counts.customers > 0,
      href: "/customers",
    },
  ];
  const completed = onboarding.filter((item) => item.complete).length;

  return (
    <PageContainer
      title={detail.application.name}
      description={t.description}
      primaryAction={{ label: t.back, href: "/applications" }}
    >
      <div className="project-detail-grid">
        <section className="card project-detail-summary">
          <div className="project-detail-title-row">
            <div>
              <span className="project-detail-kicker">{t.kicker}</span>
              <h2>{detail.application.name}</h2>
            </div>
            <div className="project-detail-badges">
              {isCurrent && <StatusBadge status="current" />}
              <StatusBadge status={detail.application.status} />
            </div>
          </div>
          <dl className="project-summary-list">
            <div>
              <dt>{t.projectId}</dt>
              <dd className="cell-mono">{detail.application.id}</dd>
            </div>
            <div>
              <dt>{t.slug}</dt>
              <dd className="cell-mono">{detail.application.slug}</dd>
            </div>
            <div>
              <dt>{t.created}</dt>
              <dd>{new Date(detail.application.createdAt).toLocaleString()}</dd>
            </div>
          </dl>
        </section>

        <section className="card onboarding-progress-card">
          <div className="onboarding-progress-heading">
            <div>
              <span className="project-detail-kicker">{t.setupKicker}</span>
              <h2>
                {formatMessage(t.setupCount, {
                  completed: String(completed),
                  total: String(onboarding.length),
                })}
              </h2>
            </div>
            <span className="onboarding-progress-value">
              {Math.round((completed / onboarding.length) * 100)}%
            </span>
          </div>
          <div className="onboarding-progress-track" aria-hidden="true">
            <span
              style={{ width: `${(completed / onboarding.length) * 100}%` }}
            />
          </div>
          <div className="onboarding-progress-list">
            {onboarding.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="onboarding-progress-item"
              >
                <span
                  className={
                    item.complete ? "setup-check is-complete" : "setup-check"
                  }
                >
                  {item.complete ? "✓" : ""}
                </span>
                <span>{item.label}</span>
              </a>
            ))}
          </div>
        </section>
      </div>

      <div className="project-detail-columns">
        <section className="card">
          <div className="card-heading-row">
            <div>
              <span className="project-detail-kicker">{t.domainsKicker}</span>
              <h2 className="card-title">{t.domainsTitle}</h2>
            </div>
          </div>
          {detail.domains.length > 0 ? (
            <div className="detail-list">
              {detail.domains.map((domain) => (
                <div key={domain.id} className="detail-list-row">
                  <div>
                    <strong>{domain.hostname}</strong>
                    <span>{domain.kind}</span>
                  </div>
                  {domain.isPrimary && (
                    <StatusBadge status="current" label={t.primary} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="card-empty-copy">
              No hostname registered yet. Add one before relying on host-based
              project resolution.
            </p>
          )}

          <div className="card-subsection">
            <span className="project-detail-kicker">
              Allowed callback origins
            </span>
            {detail.callbackOrigins.length > 0 ? (
              <div className="detail-list compact">
                {detail.callbackOrigins.map((origin) => (
                  <div key={origin.id} className="detail-list-row">
                    <code>{origin.origin}</code>
                  </div>
                ))}
              </div>
            ) : (
              <p className="card-empty-copy">{t.noCallbacks}</p>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-heading-row">
            <div>
              <span className="project-detail-kicker">{t.securityKicker}</span>
              <h2 className="card-title">{t.credentialsTitle}</h2>
            </div>
          </div>
          {detail.credentials.length > 0 ? (
            <div className="detail-list">
              {detail.credentials.map((credential) => (
                <div
                  key={credential.id}
                  className="detail-list-row credential-row"
                >
                  <div>
                    <strong>{credential.name}</strong>
                    <code>{credential.secretPrefix}••••••••</code>
                    <span>
                      {credential.lastUsedAt
                        ? formatMessage(t.lastUsed, {
                            date: new Date(
                              credential.lastUsedAt,
                            ).toLocaleString(),
                          })
                        : t.neverUsed}
                    </span>
                  </div>
                  <span
                    className={`badge ${credential.revokedAt ? "badge-revoked" : "badge-active"}`}
                  >
                    {credential.revokedAt ? t.revoked : t.active}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="card-empty-copy">{t.noCredentials}</p>
          )}
          <div className="secret-warning">{t.secretWarning}</div>
        </section>
      </div>
    </PageContainer>
  );
}
