import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProviderConnectionActions } from "@/components/providers/ProviderConnectionActions";
import { ProviderDiagnostics } from "@/components/providers/ProviderDiagnostics";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary } from "@/i18n/server";
import type { ProviderCapability } from "@/modules/providers/contract";
import { getConsoleContext } from "@/server/control-plane/context";
import { getConsoleProviderConnectionDetail } from "@/server/control-plane/providers";

export const dynamic = "force-dynamic";

type ProviderDetailPageProps = {
  params: Promise<{ connectionId: string }>;
};

function capabilityLabelsOf(t: {
  capabilities: Record<ProviderCapability, string>;
}): Record<ProviderCapability, string> {
  return t.capabilities;
}

export default async function ProviderDetailPage({
  params,
}: ProviderDetailPageProps) {
  const [{ connectionId }, context, dictionary] = await Promise.all([
    params,
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.providersDetail;
  const CAPABILITY_LABELS = capabilityLabelsOf(t);
  const application = context.selectedApplication;
  if (!application) notFound();

  const detail = await getConsoleProviderConnectionDetail(
    application.id,
    connectionId,
    context.environment,
  );
  if (!detail) notFound();

  const { connection, setup } = detail;
  const providerLabel = setup?.label ?? connection.provider;
  const environmentLabel =
    connection.mode === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  return (
    <PageContainer
      title={connection.name}
      description={formatMessage(t.description, {
        provider: providerLabel,
        application: application.name,
        environment: environmentLabel,
      })}
      primaryAction={{ label: t.back, href: "/providers" }}
    >
      <div className="provider-detail-grid">
        <section className="card provider-detail-summary">
          <div className="provider-detail-heading">
            <div>
              <span className="provider-detail-kicker">{t.kicker}</span>
              <h2>{providerLabel}</h2>
              <p>{setup?.description ?? t.defaultDescription}</p>
            </div>
            <div className="provider-detail-badges">
              <StatusBadge status={connection.mode} label={environmentLabel} />
              <StatusBadge status={connection.status} />
            </div>
          </div>

          <dl className="provider-summary-list">
            <div>
              <dt>{t.connectionId}</dt>
              <dd className="cell-mono">{connection.id}</dd>
            </div>
            <div>
              <dt>{t.provider}</dt>
              <dd className="cell-mono">{connection.provider}</dd>
            </div>
            <div>
              <dt>{t.created}</dt>
              <dd>{new Date(connection.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t.lastUpdated}</dt>
              <dd>{new Date(connection.updatedAt).toLocaleString()}</dd>
            </div>
            {connection.revokedAt && (
              <div>
                <dt>{t.revoked}</dt>
                <dd>{new Date(connection.revokedAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>

          <ProviderConnectionActions
            connectionId={connection.id}
            currentName={connection.name}
            providerLabel={providerLabel}
            status={connection.status}
            credentialFields={setup?.credentialFields ?? []}
            labels={dictionary.providerActions}
          />
        </section>

        <section className="card provider-credentials-card">
          <div className="card-heading-row">
            <div>
              <span className="provider-detail-kicker">{t.securityKicker}</span>
              <h2 className="card-title">{t.credentialsTitle}</h2>
            </div>
            <StatusBadge status="active" label={t.writeOnly} />
          </div>

          {setup && setup.credentialFields.length > 0 ? (
            <div className="provider-credential-summary-list">
              {setup.credentialFields.map((field) => (
                <div
                  key={field.key}
                  className="provider-credential-summary-row"
                >
                  <div>
                    <strong>{field.label}</strong>
                    <span>{field.help}</span>
                  </div>
                  <code>••••••••••••</code>
                </div>
              ))}
            </div>
          ) : (
            <p className="card-empty-copy">{t.noCredentialMeta}</p>
          )}

          <div className="provider-secret-note">{t.secretNote}</div>
        </section>
      </div>

      <section className="card provider-capability-card">
        <div className="card-heading-row">
          <div>
            <span className="provider-detail-kicker">{t.runtimeKicker}</span>
            <h2 className="card-title">{t.capabilitiesTitle}</h2>
          </div>
          {detail.capabilityRows.length > 0 && (
            <span className="provider-capability-count">
              {formatMessage(t.supportedCount, {
                count: String(
                  detail.capabilityRows.filter((item) => item.supported).length,
                ),
              })}
            </span>
          )}
        </div>

        {detail.capabilityRows.length > 0 ? (
          <div className="provider-capability-grid">
            {detail.capabilityRows.map((capability) => (
              <div
                key={capability.key}
                className={`provider-capability-item${capability.supported ? " is-supported" : ""}`}
              >
                <span className="provider-capability-state" aria-hidden="true">
                  {capability.supported ? "✓" : "—"}
                </span>
                <div>
                  <strong>{CAPABILITY_LABELS[capability.key]}</strong>
                  <code>{capability.key}</code>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="provider-runtime-warning">
            <strong>{t.capabilitiesUnavailable}</strong>
            <span>{detail.capabilityError ?? t.capabilitiesError}</span>
          </div>
        )}
      </section>

      <ProviderDiagnostics
        connectionId={connection.id}
        providerLabel={providerLabel}
        environment={connection.mode}
        disabled={connection.status !== "active"}
        labels={dictionary.providerDiagnostics}
      />

      <section className="card provider-environment-boundary-card">
        <div>
          <span className="provider-detail-kicker">{t.isolationKicker}</span>
          <h2 className="card-title">
            {formatMessage(t.isolationTitle, { environment: environmentLabel })}
          </h2>
        </div>
        <p>{t.isolationBody}</p>
      </section>
    </PageContainer>
  );
}
