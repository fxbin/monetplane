import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
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
  const [detail, context] = await Promise.all([
    getConsoleApplicationDetail(applicationId),
    getConsoleContext(),
  ]);

  if (!detail) notFound();

  const isCurrent = context.selectedApplication?.id === detail.application.id;
  const onboarding = [
    {
      label: "Project created",
      complete: true,
      href: `/applications/${detail.application.id}`,
    },
    {
      label: "Server key created",
      complete: detail.credentials.some((credential) => !credential.revokedAt),
      href: `/applications/${detail.application.id}`,
    },
    {
      label: "Connect payment provider",
      complete: detail.counts.providers > 0,
      href: "/providers",
    },
    {
      label: "Create first product",
      complete: detail.counts.products > 0,
      href: "/products",
    },
    {
      label: "Receive first customer",
      complete: detail.counts.customers > 0,
      href: "/customers",
    },
  ];
  const completed = onboarding.filter((item) => item.complete).length;

  return (
    <PageContainer
      title={detail.application.name}
      description="Project identity, security boundaries, credentials, and onboarding progress."
      primaryAction={{ label: "Back to projects", href: "/applications" }}
    >
      <div className="project-detail-grid">
        <section className="card project-detail-summary">
          <div className="project-detail-title-row">
            <div>
              <span className="project-detail-kicker">Project</span>
              <h2>{detail.application.name}</h2>
            </div>
            <div className="project-detail-badges">
              {isCurrent && <span className="badge badge-current">Current</span>}
              <span className={`badge badge-${detail.application.status}`}>
                {detail.application.status}
              </span>
            </div>
          </div>
          <dl className="project-summary-list">
            <div>
              <dt>Project ID</dt>
              <dd className="cell-mono">{detail.application.id}</dd>
            </div>
            <div>
              <dt>Slug</dt>
              <dd className="cell-mono">{detail.application.slug}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(detail.application.createdAt).toLocaleString()}</dd>
            </div>
          </dl>
        </section>

        <section className="card onboarding-progress-card">
          <div className="onboarding-progress-heading">
            <div>
              <span className="project-detail-kicker">Setup progress</span>
              <h2>{completed} of {onboarding.length} complete</h2>
            </div>
            <span className="onboarding-progress-value">
              {Math.round((completed / onboarding.length) * 100)}%
            </span>
          </div>
          <div className="onboarding-progress-track" aria-hidden="true">
            <span style={{ width: `${(completed / onboarding.length) * 100}%` }} />
          </div>
          <div className="onboarding-progress-list">
            {onboarding.map((item) => (
              <a key={item.label} href={item.href} className="onboarding-progress-item">
                <span className={item.complete ? "setup-check is-complete" : "setup-check"}>
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
              <span className="project-detail-kicker">Domains</span>
              <h2 className="card-title">Application hostnames</h2>
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
                  {domain.isPrimary && <span className="badge badge-current">Primary</span>}
                </div>
              ))}
            </div>
          ) : (
            <p className="card-empty-copy">
              No hostname registered yet. Add one before relying on host-based project resolution.
            </p>
          )}

          <div className="card-subsection">
            <span className="project-detail-kicker">Allowed callback origins</span>
            {detail.callbackOrigins.length > 0 ? (
              <div className="detail-list compact">
                {detail.callbackOrigins.map((origin) => (
                  <div key={origin.id} className="detail-list-row">
                    <code>{origin.origin}</code>
                  </div>
                ))}
              </div>
            ) : (
              <p className="card-empty-copy">No callback origin registered.</p>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-heading-row">
            <div>
              <span className="project-detail-kicker">Security</span>
              <h2 className="card-title">Server credentials</h2>
            </div>
          </div>
          {detail.credentials.length > 0 ? (
            <div className="detail-list">
              {detail.credentials.map((credential) => (
                <div key={credential.id} className="detail-list-row credential-row">
                  <div>
                    <strong>{credential.name}</strong>
                    <code>{credential.secretPrefix}••••••••</code>
                    <span>
                      {credential.lastUsedAt
                        ? `Last used ${new Date(credential.lastUsedAt).toLocaleString()}`
                        : "Never used"}
                    </span>
                  </div>
                  <span className={`badge ${credential.revokedAt ? "badge-revoked" : "badge-active"}`}>
                    {credential.revokedAt ? "Revoked" : "Active"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="card-empty-copy">
              No server credential exists. Generate one before integrating the SDK.
            </p>
          )}
          <div className="secret-warning">
            Existing secrets are intentionally never displayed. Rotate or create a new key rather
            than attempting to recover an old secret.
          </div>
        </section>
      </div>
    </PageContainer>
  );
}
