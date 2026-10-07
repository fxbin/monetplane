import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { PasswordChangeForm } from "@/components/settings/PasswordChangeForm";
import { getDictionary } from "@/i18n/server";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

/**
 * Settings hub (roundtable 2026-10-06, PR2): two tabs — workspace surfaces
 * (project info read-only + links to providers / API keys / team) and the
 * operator profile (self-service password change). Environment switching
 * deliberately stays in the top bar: it is console context, not
 * configuration. Project rename/archive is explicitly out of scope (see
 * the decision note).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, context, dictionary] = await Promise.all([
    searchParams,
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.settings;
  const tab = params.tab === "profile" ? "profile" : "workspace";
  const application = context.selectedApplication;

  return (
    <PageContainer title={t.title} description={t.workspaceHint}>
      <div className="developer-filter-bar" role="tablist">
        <Link
          href="/settings"
          className={`btn btn-secondary${tab === "workspace" ? " is-active" : ""}`}
          aria-current={tab === "workspace" ? "page" : undefined}
        >
          {t.workspaceTab}
        </Link>
        <Link
          href="/settings?tab=profile"
          className={`btn btn-secondary${tab === "profile" ? " is-active" : ""}`}
          aria-current={tab === "profile" ? "page" : undefined}
        >
          {t.profileTab}
        </Link>
      </div>

      {tab === "workspace" ? (
        <>
          {application ? (
            <section className="card">
              <h2 className="card-title">{t.projectCard}</h2>
              <dl className="project-summary-list">
                <div>
                  <dt>{t.projectName}</dt>
                  <dd>{application.name}</dd>
                </div>
                <div>
                  <dt>{t.projectSlug}</dt>
                  <dd className="cell-mono">{application.slug}</dd>
                </div>
                <div>
                  <dt>{t.projectId}</dt>
                  <dd className="cell-mono">{application.id}</dd>
                </div>
              </dl>
              <p className="cell-muted">
                <Link href={`/applications/${application.id}`}>
                  {t.projectDomains} →
                </Link>
              </p>
            </section>
          ) : (
            <p className="cell-muted">{dictionary.common.noProjectTitle}</p>
          )}

          <section className="card">
            <h2 className="card-title">{t.manageLinks}</h2>
            <div className="detail-list">
              <div className="detail-list-row">
                <div>
                  <strong>{t.providersLink}</strong>
                  <span>{t.providersDesc}</span>
                </div>
                <Link className="btn btn-secondary" href="/providers">
                  →
                </Link>
              </div>
              <div className="detail-list-row">
                <div>
                  <strong>{t.apiKeysLink}</strong>
                  <span>{t.apiKeysDesc}</span>
                </div>
                <Link className="btn btn-secondary" href="/api-keys">
                  →
                </Link>
              </div>
              <div className="detail-list-row">
                <div>
                  <strong>{t.teamLink}</strong>
                  <span>{t.teamDesc}</span>
                </div>
                <Link className="btn btn-secondary" href="/team">
                  →
                </Link>
              </div>
            </div>
          </section>
        </>
      ) : (
        <section className="card">
          <h2 className="card-title">{t.profileTitle}</h2>
          <p className="cell-muted">{t.profileDesc}</p>
        </section>
      )}

      {tab === "profile" && <PasswordChangeForm labels={t} />}
    </PageContainer>
  );
}
