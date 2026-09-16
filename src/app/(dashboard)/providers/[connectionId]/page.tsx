import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProviderConnectionActions } from "@/components/providers/ProviderConnectionActions";
import { ProviderDiagnostics } from "@/components/providers/ProviderDiagnostics";
import type { ProviderCapability } from "@/modules/providers/contract";
import { getConsoleContext } from "@/server/control-plane/context";
import { getConsoleProviderConnectionDetail } from "@/server/control-plane/providers";

export const dynamic = "force-dynamic";

type ProviderDetailPageProps = {
  params: Promise<{ connectionId: string }>;
};

const CAPABILITY_LABELS: Record<ProviderCapability, string> = {
  one_time_checkout: "One-time checkout",
  recurring_subscription: "Recurring subscriptions",
  monthly_interval: "Monthly interval",
  annual_interval: "Annual interval",
  refund: "Refunds",
  subscription_cancel: "Subscription cancellation",
  subscription_update: "Subscription updates",
  customer_portal: "Customer portal",
  provider_hosted_checkout: "Provider-hosted checkout",
};

export default async function ProviderDetailPage({
  params,
}: ProviderDetailPageProps) {
  const [{ connectionId }, context] = await Promise.all([
    params,
    getConsoleContext(),
  ]);
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
    connection.mode === "test" ? "Sandbox" : "Production";

  return (
    <PageContainer
      title={connection.name}
      description={`${providerLabel} connection for ${application.name} · ${environmentLabel}`}
      primaryAction={{ label: "Back to providers", href: "/providers" }}
    >
      <div className="provider-detail-grid">
        <section className="card provider-detail-summary">
          <div className="provider-detail-heading">
            <div>
              <span className="provider-detail-kicker">
                Provider connection
              </span>
              <h2>{providerLabel}</h2>
              <p>
                {setup?.description ?? "Provider-managed payment connection."}
              </p>
            </div>
            <div className="provider-detail-badges">
              <span className={`badge badge-${connection.mode}`}>
                {environmentLabel}
              </span>
              <span className={`badge badge-${connection.status}`}>
                {connection.status}
              </span>
            </div>
          </div>

          <dl className="provider-summary-list">
            <div>
              <dt>Connection ID</dt>
              <dd className="cell-mono">{connection.id}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd className="cell-mono">{connection.provider}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(connection.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{new Date(connection.updatedAt).toLocaleString()}</dd>
            </div>
            {connection.revokedAt && (
              <div>
                <dt>Revoked</dt>
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
          />
        </section>

        <section className="card provider-credentials-card">
          <div className="card-heading-row">
            <div>
              <span className="provider-detail-kicker">Security</span>
              <h2 className="card-title">Credentials</h2>
            </div>
            <span className="badge badge-active">Write-only</span>
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
            <p className="card-empty-copy">
              Credential field metadata is unavailable for this provider.
            </p>
          )}

          <div className="provider-secret-note">
            Plaintext credentials are never returned by the console API.
            Reconfigure replaces the complete encrypted credential set instead
            of revealing the existing values.
          </div>
        </section>
      </div>

      <section className="card provider-capability-card">
        <div className="card-heading-row">
          <div>
            <span className="provider-detail-kicker">Runtime contract</span>
            <h2 className="card-title">Capabilities</h2>
          </div>
          {detail.capabilityRows.length > 0 && (
            <span className="provider-capability-count">
              {detail.capabilityRows.filter((item) => item.supported).length}{" "}
              supported
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
            <strong>Capabilities unavailable</strong>
            <span>
              {detail.capabilityError ??
                "The provider runtime could not resolve this connection."}
            </span>
          </div>
        )}
      </section>

      <ProviderDiagnostics
        connectionId={connection.id}
        providerLabel={providerLabel}
        environment={connection.mode}
        disabled={connection.status !== "active"}
      />

      <section className="card provider-environment-boundary-card">
        <div>
          <span className="provider-detail-kicker">Isolation boundary</span>
          <h2 className="card-title">{environmentLabel} only</h2>
        </div>
        <p>
          This detail page and its management API are scoped to the selected
          project and current console environment. Switching Sandbox /
          Production makes a connection from the other mode resolve as not found
          rather than silently crossing credential boundaries.
        </p>
      </section>
    </PageContainer>
  );
}
