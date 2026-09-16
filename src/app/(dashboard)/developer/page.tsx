import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { getConsoleContext } from "@/server/control-plane/context";
import {
  getDeveloperHealth,
  getDeveloperQuickstart,
} from "@/server/control-plane/developer";

export const dynamic = "force-dynamic";

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="developer-code">
      <code>{children}</code>
    </pre>
  );
}

export default async function DeveloperQuickstartPage() {
  const context = await getConsoleContext();
  const application = context.selectedApplication;
  const environmentLabel = context.environment === "test" ? "Sandbox" : "Production";

  if (!application) {
    return (
      <PageContainer
        title="Developer Quickstart"
        description="Create a project before integrating the server SDK."
      >
        <div className="empty-state">
          <h2 className="empty-state-title">Start with a project</h2>
          <p className="empty-state-desc">
            A project owns your catalog, customers, API credentials, and provider connections.
          </p>
          <div className="empty-state-actions">
            <Link className="btn btn-primary" href="/applications/new">
              Create project
            </Link>
          </div>
        </div>
      </PageContainer>
    );
  }

  const [health, quickstart] = await Promise.all([
    getDeveloperHealth(application.id, context.environment),
    getDeveloperQuickstart(application.id, context.environment),
  ]);
  const providerId = quickstart.provider?.id ?? "pc_your_provider_connection";
  const priceId = quickstart.catalog?.priceId ?? "price_your_price";
  const checks = [
    {
      label: "Server API key issued",
      done: health.apiKeyCreated,
      href: "/api-keys",
      action: "Create key",
    },
    {
      label: "Authenticated API request received",
      done: health.apiRequestReceived,
      href: "/developer#sdk",
      action: "Run SDK call",
    },
    {
      label: `${environmentLabel} webhook endpoint configured`,
      done: health.webhookConfigured,
      href: "/webhooks",
      action: "Add endpoint",
    },
    {
      label: "Webhook delivery succeeded",
      done: health.webhookDelivered,
      href: "/webhooks",
      action: "Send test",
    },
    {
      label: "Provider event received",
      done: health.firstProviderEventReceived,
      href: "/events",
      action: "View events",
    },
    {
      label: "First payment received",
      done: health.firstPaymentReceived,
      href: "/payments",
      action: "View payments",
    },
  ];

  const initSnippet = `import { createMonetPlaneClient } from "@monetplane/sdk/server";

const monetplane = createMonetPlaneClient({
  baseUrl: process.env.MONETPLANE_BASE_URL!,
  appSecret: process.env.MONETPLANE_APP_SECRET!,
});`;

  const customerSnippet = `await monetplane.upsertCustomer({
  externalCustomerId: "user_123",
  email: "user@example.com",
  metadata: { planSource: "app" },
});`;

  const checkoutSnippet = `const checkout = await monetplane.createCheckout({
  externalCustomerId: "user_123",
  providerConnectionId: "${providerId}",
  items: [{ priceId: "${priceId}", quantity: 1 }],
  successUrl: "https://app.example.com/billing/success",
  cancelUrl: "https://app.example.com/billing/cancel",
});

redirect(checkout.checkoutUrl);`;

  const accessSnippet = `const access = await monetplane.checkEntitlement({
  externalCustomerId: "user_123",
  entitlementKey: "pro_access",
});

const credits = await monetplane.getCreditBalance(
  "user_123",
  "ai_tokens",
);`;

  return (
    <PageContainer
      title="Developer Quickstart"
      description={`Connect ${application.name} to MonetPlane in about 10 minutes.`}
    >
      <div className="context-notice">
        <span className="context-notice-label">Current provider environment</span>
        <strong>{environmentLabel}</strong>
        <span>
          Provider connection IDs and webhook endpoints follow this environment. Server API keys are project-wide today.
        </span>
      </div>

      <section className="developer-health-grid" aria-label="Integration health">
        {checks.map((check) => (
          <article className={`developer-health-card ${check.done ? "is-done" : ""}`} key={check.label}>
            <span className="developer-health-icon" aria-hidden="true">
              {check.done ? "✓" : "○"}
            </span>
            <div>
              <strong>{check.label}</strong>
              <p>{check.done ? "Observed by MonetPlane" : "Not observed yet"}</p>
            </div>
            <Link href={check.href}>{check.done ? "Inspect" : check.action}</Link>
          </article>
        ))}
      </section>

      <div className="developer-quickstart-layout" id="sdk">
        <section className="developer-panel developer-quickstart-main">
          <div className="developer-panel-heading">
            <div>
              <span className="developer-step">01</span>
              <h2>Keep the secret on your server</h2>
              <p>
                Create an API key, put it in your server secret manager, and never expose it through browser bundles, public environment variables, or client-side code.
              </p>
            </div>
            <Link className="btn btn-secondary" href="/api-keys">
              Manage API keys
            </Link>
          </div>
          <CodeBlock>{`MONETPLANE_BASE_URL=https://billing.example.com\nMONETPLANE_APP_SECRET=mp_app_••••••••`}</CodeBlock>

          <div className="developer-sdk-distribution-note">
            <strong>SDK distribution status</strong>
            <span>
              This repository currently keeps the SDK under <code>src/sdk</code> and the root package is private. A public package publish step is not configured yet. The code below uses the exact current server SDK contract rather than pretending a package is already published.
            </span>
          </div>

          <div className="developer-panel-heading developer-step-heading">
            <div>
              <span className="developer-step">02</span>
              <h2>Initialize the server SDK</h2>
            </div>
          </div>
          <CodeBlock>{initSnippet}</CodeBlock>

          <div className="developer-panel-heading developer-step-heading">
            <div>
              <span className="developer-step">03</span>
              <h2>Identify your customer</h2>
            </div>
          </div>
          <CodeBlock>{customerSnippet}</CodeBlock>

          <div className="developer-panel-heading developer-step-heading">
            <div>
              <span className="developer-step">04</span>
              <h2>Create checkout</h2>
              <p>
                The example uses the first active {environmentLabel} provider and first active project price when available.
              </p>
            </div>
          </div>
          <CodeBlock>{checkoutSnippet}</CodeBlock>

          <div className="developer-panel-heading developer-step-heading">
            <div>
              <span className="developer-step">05</span>
              <h2>Gate features and consume credits</h2>
            </div>
          </div>
          <CodeBlock>{accessSnippet}</CodeBlock>
        </section>

        <aside className="developer-panel developer-reference-card">
          <h2>Current references</h2>
          <dl>
            <div>
              <dt>Project</dt>
              <dd className="cell-mono">{application.id}</dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>{environmentLabel}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd className="cell-mono">{quickstart.provider?.id ?? "Not connected"}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd className="cell-mono">{quickstart.catalog?.priceId ?? "No active price"}</dd>
            </div>
          </dl>
          {!quickstart.provider && (
            <Link className="btn btn-primary" href="/providers/new">
              Connect {environmentLabel} provider
            </Link>
          )}
          {!quickstart.catalog && (
            <Link className="btn btn-secondary" href="/products/new">
              Create product
            </Link>
          )}
        </aside>
      </div>
    </PageContainer>
  );
}
